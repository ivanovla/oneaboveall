import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids } from "../../src/db/schema";
import { recordBid } from "../../src/engine/recordBid";
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

async function seedRound(priceCents: number, phase: "bidding" | "closed" = "bidding", startsAt: Date = new Date()) {
  const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents, startedAt: startsAt }).returning();
  const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt, phase }).returning();
  return round.id;
}

async function bidByRef(paymentRef: string) {
  const [bid] = await db.select().from(bids).where(eq(bids.paymentRef, paymentRef));
  return bid;
}

describe("recordBid", () => {
  it("records a bid and releases nothing when the queue was empty", async () => {
    const roundId = await seedRound(10_000);
    const provider = new FakePaymentProvider();
    const notifier = new FakeNotifier();

    const result = await recordBid({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", now: new Date() }, provider, notifier);

    expect(result.outcome).toBe("recorded");
    expect(provider.releases).toEqual([]);
    expect(notifier.outbids).toEqual([]);
    expect((await bidByRef("pi_a")).refundedAt).toBeNull();
  });

  it("keeps the displaced leader's hold alive as the runner-up and notifies them", async () => {
    const roundId = await seedRound(10_000);
    const provider = new FakePaymentProvider();
    const notifier = new FakeNotifier();

    await recordBid({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", now: new Date() }, provider, notifier);
    const result = await recordBid({ roundId, bidderId: "b", amountCents: 12_000, paymentRef: "pi_b", now: new Date() }, provider, notifier);

    expect(result.outcome).toBe("recorded");
    // "a" is now the runner-up — the fallback if capturing "b" fails at the
    // close — so their hold must NOT be released yet.
    expect(provider.releases).toEqual([]);
    expect((await bidByRef("pi_a")).refundedAt).toBeNull();
    expect(notifier.outbids).toEqual([{ bidderId: "a", amountCents: 12_000 }]);
  });

  it("releases everything below the top bid and the runner-up", async () => {
    const roundId = await seedRound(10_000);
    const provider = new FakePaymentProvider();
    const notifier = new FakeNotifier();

    await recordBid({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", now: new Date() }, provider, notifier);
    await recordBid({ roundId, bidderId: "b", amountCents: 12_000, paymentRef: "pi_b", now: new Date() }, provider, notifier);
    await recordBid({ roundId, bidderId: "c", amountCents: 13_000, paymentRef: "pi_c", now: new Date() }, provider, notifier);

    expect(provider.releases).toEqual(["pi_a"]);
    expect((await bidByRef("pi_a")).refundedAt).not.toBeNull();
    expect((await bidByRef("pi_b")).refundedAt).toBeNull();
    expect((await bidByRef("pi_c")).refundedAt).toBeNull();
    expect(notifier.outbids.map((o) => o.bidderId)).toEqual(["a", "b"]);
  });

  it("releases a bidder's own older hold when they re-bid after being outbid", async () => {
    const roundId = await seedRound(10_000);
    const provider = new FakePaymentProvider();
    const notifier = new FakeNotifier();

    await recordBid({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a1", now: new Date() }, provider, notifier);
    await recordBid({ roundId, bidderId: "b", amountCents: 12_000, paymentRef: "pi_b", now: new Date() }, provider, notifier);
    await recordBid({ roundId, bidderId: "a", amountCents: 13_000, paymentRef: "pi_a2", now: new Date() }, provider, notifier);

    // "a"'s first hold is redundant — the runner-up must be a *different*
    // bidder than the top, so "b" (not "a"'s own older bid) stays held.
    expect(provider.releases).toEqual(["pi_a1"]);
    expect((await bidByRef("pi_b")).refundedAt).toBeNull();
    expect((await bidByRef("pi_a2")).refundedAt).toBeNull();
    expect(notifier.outbids.map((o) => o.bidderId)).toEqual(["a", "b"]);
  });

  it("releases the just-authorized hold when the bid no longer qualifies by the time the webhook lands", async () => {
    const roundId = await seedRound(10_000);
    const provider = new FakePaymentProvider();
    const notifier = new FakeNotifier();

    await recordBid({ roundId, bidderId: "a", amountCents: 50_000, paymentRef: "pi_a", now: new Date() }, provider, notifier);
    const result = await recordBid({ roundId, bidderId: "b", amountCents: 11_000, paymentRef: "pi_b", now: new Date() }, provider, notifier);

    expect(result.outcome).toBe("released");
    expect(provider.releases).toEqual(["pi_b"]);
    expect(await db.select().from(bids).where(eq(bids.paymentRef, "pi_b"))).toHaveLength(0);
    expect(notifier.outbids).toEqual([]);
  });

  it("releases rather than records once the round has closed", async () => {
    const roundId = await seedRound(10_000, "closed");
    const provider = new FakePaymentProvider();

    const result = await recordBid({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", now: new Date() }, provider);

    expect(result.outcome).toBe("released");
    expect(provider.releases).toEqual(["pi_a"]);
  });

  it("releases a late webhook for a bid landing at/after the daily close, even though the phase is still bidding", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const roundId = await seedRound(10_000, "bidding", startsAt);
    const closeAt = nextDailyCloseAt(startsAt);
    const provider = new FakePaymentProvider();
    const notifier = new FakeNotifier();

    await recordBid({ roundId, bidderId: "winner", amountCents: 11_000, paymentRef: "pi_w", now: new Date(startsAt.getTime() + 1000) }, provider, notifier);
    const late = await recordBid({ roundId, bidderId: "late", amountCents: 50_000, paymentRef: "pi_late", now: closeAt }, provider, notifier);

    expect(late.outcome).toBe("released");
    expect(provider.releases).toEqual(["pi_late"]);
    // The true winner is untouched and nobody was told they were outbid.
    expect((await bidByRef("pi_w")).refundedAt).toBeNull();
    expect(notifier.outbids).toEqual([]);
  });

  it("judges the close by the bid's placedAt (when the hold was authorized), not by when the webhook was processed", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const roundId = await seedRound(10_000, "bidding", startsAt);
    const closeAt = nextDailyCloseAt(startsAt);
    const provider = new FakePaymentProvider();
    const authorizedAt = new Date(closeAt.getTime() - 2000);
    const processedAt = new Date(closeAt.getTime() + 5000);

    const result = await recordBid(
      { roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", now: processedAt, placedAt: authorizedAt },
      provider,
    );

    expect(result.outcome).toBe("recorded");
    expect(provider.releases).toEqual([]);
    expect((await bidByRef("pi_a")).placedAt).toEqual(authorizedAt);
  });

  it("is idempotent — a redelivered webhook neither re-inserts, re-releases, nor re-notifies", async () => {
    const roundId = await seedRound(10_000);
    const provider = new FakePaymentProvider();
    const notifier = new FakeNotifier();

    await recordBid({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", now: new Date() }, provider, notifier);
    await recordBid({ roundId, bidderId: "b", amountCents: 12_000, paymentRef: "pi_b", now: new Date() }, provider, notifier);
    await recordBid({ roundId, bidderId: "c", amountCents: 13_000, paymentRef: "pi_c", now: new Date() }, provider, notifier);
    expect(provider.releases).toEqual(["pi_a"]);

    const redelivered = await recordBid({ roundId, bidderId: "c", amountCents: 13_000, paymentRef: "pi_c", now: new Date() }, provider, notifier);
    expect(redelivered.outcome).toBe("already-recorded");
    expect(provider.releases).toEqual(["pi_a"]);
    expect(notifier.outbids).toHaveLength(2);
  });

  it("a redelivery finishes releases that a previous attempt crashed before completing", async () => {
    const roundId = await seedRound(10_000);
    const provider = new FakePaymentProvider();

    await recordBid({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", now: new Date() }, provider);
    await recordBid({ roundId, bidderId: "b", amountCents: 12_000, paymentRef: "pi_b", now: new Date() }, provider);

    // The release of "a" fails transiently (Stripe outage) — the webhook
    // must fail so Stripe redelivers, and the DB must not claim "a" was
    // released.
    provider.throwOnRelease.add("pi_a");
    await expect(
      recordBid({ roundId, bidderId: "c", amountCents: 13_000, paymentRef: "pi_c", now: new Date() }, provider),
    ).rejects.toThrow();
    expect((await bidByRef("pi_a")).refundedAt).toBeNull();

    provider.throwOnRelease.clear();
    const redelivered = await recordBid({ roundId, bidderId: "c", amountCents: 13_000, paymentRef: "pi_c", now: new Date() }, provider);
    expect(redelivered.outcome).toBe("already-recorded");
    expect(provider.releases).toEqual(["pi_a"]);
    expect((await bidByRef("pi_a")).refundedAt).not.toBeNull();
  });

  it("a failing notifier never breaks bookkeeping", async () => {
    const roundId = await seedRound(10_000);
    const provider = new FakePaymentProvider();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const notifier = {
      outbid: async () => {
        throw new Error("email down");
      },
      won: async () => {},
    };

    await recordBid({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", now: new Date() }, provider, notifier);
    const result = await recordBid({ roundId, bidderId: "b", amountCents: 12_000, paymentRef: "pi_b", now: new Date() }, provider, notifier);

    expect(result.outcome).toBe("recorded");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("never releases a bid that has already been captured", async () => {
    const roundId = await seedRound(10_000);
    const provider = new FakePaymentProvider();

    await recordBid({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", now: new Date() }, provider);
    await db.update(bids).set({ capturedAt: new Date() }).where(eq(bids.paymentRef, "pi_a"));
    await recordBid({ roundId, bidderId: "b", amountCents: 12_000, paymentRef: "pi_b", now: new Date() }, provider);
    await recordBid({ roundId, bidderId: "c", amountCents: 13_000, paymentRef: "pi_c", now: new Date() }, provider);

    expect(provider.releases).toEqual([]);
    expect((await bidByRef("pi_a")).refundedAt).toBeNull();
  });
});
