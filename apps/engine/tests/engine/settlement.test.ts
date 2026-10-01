import { describe, it, expect, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids } from "../../src/db/schema";
import { settleRound } from "../../src/engine/settlement";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";
import { FakeNotifier } from "../../src/notifications/FakeNotifier";
import { nextDailyCloseAt } from "../../src/domain/dailyClose";

afterEach(async () => {
  await db.delete(bids);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

const startsAt = new Date(2026, 0, 1, 0, 0, 0);
const closeAt = nextDailyCloseAt(startsAt);
const settleAt = new Date(closeAt.getTime() + 1000);

async function seedRound() {
  const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: startsAt }).returning();
  const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt, phase: "bidding" }).returning();
  return round.id;
}

async function seedBid(roundId: string, bidderId: string, amountCents: number, paymentRef: string, placedAt?: Date) {
  await db.insert(bids).values({
    roundId,
    bidderId,
    amountCents,
    paymentRef,
    placedAt: placedAt ?? new Date(startsAt.getTime() + amountCents),
  });
}

async function bidByRef(paymentRef: string) {
  const [bid] = await db.select().from(bids).where(eq(bids.paymentRef, paymentRef));
  return bid;
}

describe("settleRound", () => {
  it("reports nothing captured for a round with no bids", async () => {
    const roundId = await seedRound();
    const provider = new FakePaymentProvider();
    const notifier = new FakeNotifier();

    const result = await settleRound(roundId, closeAt, { provider, notifier }, settleAt);

    expect(result.outcome).toBe("nothing-captured");
    expect(provider.captures).toEqual([]);
    expect(notifier.wins).toEqual([]);
  });

  it("captures the leader, releases the runner-up, and notifies the winner", async () => {
    const roundId = await seedRound();
    await seedBid(roundId, "a", 11_000, "pi_a");
    await seedBid(roundId, "b", 12_000, "pi_b");
    const provider = new FakePaymentProvider();
    const notifier = new FakeNotifier();

    const result = await settleRound(roundId, closeAt, { provider, notifier }, settleAt);

    expect(result.outcome).toBe("captured");
    expect(provider.captures).toEqual(["pi_b"]);
    expect(provider.releases).toEqual(["pi_a"]);
    expect((await bidByRef("pi_b")).capturedAt).toEqual(settleAt);
    expect((await bidByRef("pi_b")).refundedAt).toBeNull();
    expect((await bidByRef("pi_a")).refundedAt).not.toBeNull();
    expect(notifier.wins).toEqual([{ bidderId: "b", amountCents: 12_000 }]);
  });

  it("is idempotent — settling an already-settled round captures, releases and notifies nothing more", async () => {
    const roundId = await seedRound();
    await seedBid(roundId, "a", 11_000, "pi_a");
    await seedBid(roundId, "b", 12_000, "pi_b");
    const provider = new FakePaymentProvider();
    const notifier = new FakeNotifier();

    await settleRound(roundId, closeAt, { provider, notifier }, settleAt);
    const again = await settleRound(roundId, closeAt, { provider, notifier }, new Date(settleAt.getTime() + 5000));

    expect(again.outcome).toBe("captured");
    expect(provider.captures).toEqual(["pi_b"]);
    expect(provider.releases).toEqual(["pi_a"]);
    expect(notifier.wins).toHaveLength(1);
  });

  it("falls back to the runner-up when capturing the leader definitively fails", async () => {
    const roundId = await seedRound();
    await seedBid(roundId, "a", 11_000, "pi_a");
    await seedBid(roundId, "b", 12_000, "pi_b");
    const provider = new FakePaymentProvider();
    provider.declineCapture.add("pi_b");
    const notifier = new FakeNotifier();

    const result = await settleRound(roundId, closeAt, { provider, notifier }, settleAt);

    expect(result.outcome).toBe("captured");
    expect(provider.captures).toEqual(["pi_a"]); // only successful captures are recorded
    const failed = await bidByRef("pi_b");
    expect(failed.captureFailedAt).not.toBeNull();
    expect(failed.refundedAt).not.toBeNull();
    expect(failed.capturedAt).toBeNull();
    expect(provider.releases).toContain("pi_b");
    expect((await bidByRef("pi_a")).capturedAt).not.toBeNull();
    expect(notifier.wins).toEqual([{ bidderId: "a", amountCents: 11_000 }]);
  });

  it("reports nothing captured when every hold fails to capture, leaving them all released", async () => {
    const roundId = await seedRound();
    await seedBid(roundId, "a", 11_000, "pi_a");
    await seedBid(roundId, "b", 12_000, "pi_b");
    const provider = new FakePaymentProvider();
    provider.declineCapture.add("pi_a");
    provider.declineCapture.add("pi_b");
    const notifier = new FakeNotifier();

    const result = await settleRound(roundId, closeAt, { provider, notifier }, settleAt);

    expect(result.outcome).toBe("nothing-captured");
    expect((await bidByRef("pi_a")).refundedAt).not.toBeNull();
    expect((await bidByRef("pi_b")).refundedAt).not.toBeNull();
    expect(notifier.wins).toEqual([]);
  });

  it("throws on a transient capture error and leaves every bid untouched for the next attempt", async () => {
    const roundId = await seedRound();
    await seedBid(roundId, "a", 11_000, "pi_a");
    await seedBid(roundId, "b", 12_000, "pi_b");
    const provider = new FakePaymentProvider();
    provider.throwOnCapture.add("pi_b");
    const notifier = new FakeNotifier();

    await expect(settleRound(roundId, closeAt, { provider, notifier }, settleAt)).rejects.toThrow();

    for (const ref of ["pi_a", "pi_b"]) {
      const bid = await bidByRef(ref);
      expect(bid.refundedAt).toBeNull();
      expect(bid.capturedAt).toBeNull();
      expect(bid.captureFailedAt).toBeNull();
    }
    expect(provider.releases).toEqual([]);

    // Next tick: Stripe is back.
    provider.throwOnCapture.clear();
    const result = await settleRound(roundId, closeAt, { provider, notifier }, settleAt);
    expect(result.outcome).toBe("captured");
    expect((await bidByRef("pi_b")).capturedAt).not.toBeNull();
    expect(notifier.wins).toHaveLength(1);
  });

  it("never captures a bid placed after the close, and releases it", async () => {
    const roundId = await seedRound();
    await seedBid(roundId, "honest", 11_000, "pi_honest");
    await seedBid(roundId, "sniper", 99_000, "pi_sniper", new Date(closeAt.getTime() + 1000));
    const provider = new FakePaymentProvider();

    const result = await settleRound(roundId, closeAt, { provider, notifier: new FakeNotifier() }, settleAt);

    expect(result.outcome).toBe("captured");
    expect(provider.captures).toEqual(["pi_honest"]);
    expect(provider.releases).toEqual(["pi_sniper"]);
  });

  it("treats a capture that succeeded at Stripe but was never marked (crash) as captured on retry, notifying once", async () => {
    const roundId = await seedRound();
    await seedBid(roundId, "a", 11_000, "pi_a");
    const provider = new FakePaymentProvider();
    const notifier = new FakeNotifier();

    // Simulate: Stripe already captured pi_a, but our row was never updated.
    await provider.capture("pi_a");
    const result = await settleRound(roundId, closeAt, { provider, notifier }, settleAt);

    expect(result.outcome).toBe("captured");
    expect((await bidByRef("pi_a")).capturedAt).not.toBeNull();
    expect(notifier.wins).toHaveLength(1);
  });
});
