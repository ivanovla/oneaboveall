import { describe, it, expect, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, roundParticipants } from "../../src/db/schema";
import { joinRound } from "../../src/engine/joinRound";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";
import type { PaymentProvider } from "../../src/payments/PaymentProvider";

afterEach(async () => {
  await db.delete(roundParticipants);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

async function seedRound(phase: "bidding" | "resolving" | "payment" | "closed" = "bidding") {
  const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: new Date() }).returning();
  const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date(), phase }).returning();
  return round.id;
}

describe("joinRound", () => {
  it("creates a held round participant on first call", async () => {
    const roundId = await seedRound();
    const provider = new FakePaymentProvider();

    const result = await joinRound(
      { roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() },
      provider,
    );

    expect(result.outcome).toBe("joined");
    const [row] = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    expect(row.bidderId).toBe("a");
    expect(row.depositStatus).toBe("held");
    expect(provider.refunds).toHaveLength(0);
  });

  it("is idempotent — a duplicate call for the same (roundId, bidderId) is a safe no-op", async () => {
    const roundId = await seedRound();
    const provider = new FakePaymentProvider();

    await joinRound({ roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() }, provider);
    const second = await joinRound(
      { roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_2", paymentMethodRef: "pm_2", now: new Date() },
      provider,
    );

    expect(second.outcome).toBe("already-joined");
    const rows = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    expect(rows).toHaveLength(1);
  });

  it("two concurrent calls for the same (roundId, bidderId) resolve to exactly one 'joined'", async () => {
    const roundId = await seedRound();
    const provider = new FakePaymentProvider();

    const [a, b] = await Promise.all([
      joinRound({ roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() }, provider),
      joinRound({ roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_2", paymentMethodRef: "pm_2", now: new Date() }, provider),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["already-joined", "joined"]);
  });

  it("refunds immediately and does not grant bidding rights when the round already left the bidding phase", async () => {
    // A genuine race: the round can snapshot/close between the user clicking
    // "Join" and Stripe's webhook actually arriving. The deposit was already
    // charged — it must not be stranded as a "held" row nothing will ever
    // resolve.
    const roundId = await seedRound("resolving");
    const provider = new FakePaymentProvider();

    const result = await joinRound(
      { roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() },
      provider,
    );

    expect(result.outcome).toBe("refunded-round-closed");
    expect(provider.refunds).toEqual(["pi_1"]);
    const [row] = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    expect(row.depositStatus).toBe("refunded");
  });

  it("throws if the round does not exist", async () => {
    const provider = new FakePaymentProvider();
    await expect(
      joinRound(
        { roundId: "00000000-0000-0000-0000-000000000000", bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() },
        provider,
      ),
    ).rejects.toThrow("Round not found");
  });

  it("leaves the row 'held' (not falsely 'refunded') if provider.refund throws after the row is inserted", async () => {
    // Regression for a defect the plan's own brief had: baking "refunded"
    // into the INSERT (before the refund call actually happens) means a
    // provider failure here would permanently claim a refund that never
    // occurred, and a webhook redelivery afterward would just hit the
    // unique-violation "already-joined" path and never retry it. The row
    // must stay "held" — the recoverable state close-time sweeps expect —
    // until the refund has actually succeeded.
    const roundId = await seedRound("resolving");
    const throwingProvider: PaymentProvider = {
      async chargeRemainderOffSession() {
        return "succeeded";
      },
      async refund() {
        throw new Error("stripe unavailable");
      },
    };

    await expect(
      joinRound(
        { roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() },
        throwingProvider,
      ),
    ).rejects.toThrow("stripe unavailable");

    const [row] = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    expect(row.depositStatus).toBe("held");
  });

  it("refunds when the phase is still 'bidding' but the 12h window has already elapsed", async () => {
    // A round keeps phase "bidding" from T0 until the scheduler's tick
    // actually snapshots it — phase alone is not authoritative for whether
    // the round is still open. placeBid.ts already enforces this window;
    // joinRound must treat the same gap as closed, not open.
    const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: new Date() }).returning();
    const startsAt = new Date(Date.now() - 13 * 60 * 60 * 1000); // 13h ago — past the 12h bidding window
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt, phase: "bidding" }).returning();
    const provider = new FakePaymentProvider();

    const result = await joinRound(
      { roundId: round.id, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() },
      provider,
    );

    expect(result.outcome).toBe("refunded-round-closed");
    expect(provider.refunds).toEqual(["pi_1"]);
    const [row] = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, round.id));
    expect(row.depositStatus).toBe("refunded");
  });

  it("does not refund on a true webhook redelivery — same depositRef twice is a pure no-op", async () => {
    const roundId = await seedRound();
    const provider = new FakePaymentProvider();

    await joinRound({ roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() }, provider);
    const second = await joinRound(
      { roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() },
      provider,
    );

    expect(second.outcome).toBe("already-joined");
    expect(provider.refunds).toHaveLength(0);
  });

  it("refunds the redundant charge when a genuinely distinct PaymentIntent succeeds for a bidder who already joined", async () => {
    // Two tabs: the bidder's first checkout succeeds and joins them. A retry
    // in a second tab also succeeds, charging a second, distinct
    // PaymentIntent for the same (roundId, bidderId). The first join stands
    // (the unique constraint rejects the second insert), but the second
    // charge is real money that must not vanish untracked.
    const roundId = await seedRound();
    const provider = new FakePaymentProvider();

    await joinRound({ roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() }, provider);
    const second = await joinRound(
      { roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_2", paymentMethodRef: "pm_2", now: new Date() },
      provider,
    );

    expect(second.outcome).toBe("already-joined");
    expect(provider.refunds).toEqual(["pi_2"]);
    const [row] = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    expect(row.depositRef).toBe("pi_1");
  });
});
