import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans, paymentOffers, roundParticipants } from "../../src/db/schema";
import { resolveBiddingPhaseSnapshot } from "../../src/engine/roundResolution";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";
import { eq } from "drizzle-orm";
import { PAYMENT_ATTEMPT_MS, ROUND_MS, BIDDING_PHASE_MS } from "../../src/domain/config";

afterEach(async () => {
  await db.delete(paymentOffers);
  await db.delete(roundParticipants);
  await db.delete(bids);
  await db.delete(bans);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

async function seedRound(startsAt: Date) {
  const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: startsAt }).returning();
  const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt, phase: "bidding" }).returning();
  return { reignId: reign.id, roundId: round.id };
}

async function join(roundId: string, bidderId: string, depositRef: string) {
  await db.insert(roundParticipants).values({ roundId, bidderId, depositCents: 1_100, depositRef, paymentMethodRef: `pm_${bidderId}` });
}

describe("resolveBiddingPhaseSnapshot", () => {
  it("closes the round with no change when the queue is empty", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);

    const result = await resolveBiddingPhaseSnapshot(roundId, snapshotAt, new FakePaymentProvider());
    expect(result.outcome).toBe("empty-closed");

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("closed");
  });

  it("refunds a participant who joined but never placed a bid before closing the empty round", async () => {
    // Deposits live on roundParticipants now, decoupled from bidding: "no
    // leader" no longer implies "no deposits to give back". A join with no
    // bid (or whose every bid landed after snapshotAt and got filtered out)
    // must still get its money back, or it is stuck at "held" forever —
    // nothing else in the engine ever refunds it.
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    await join(roundId, "joined-never-bid", "pi_never_bid");
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);
    const provider = new FakePaymentProvider();

    const result = await resolveBiddingPhaseSnapshot(roundId, snapshotAt, provider);
    expect(result.outcome).toBe("empty-closed");

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("closed");

    const [participant] = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    expect(participant.depositStatus).toBe("refunded");
    expect(provider.refunds).toContain("pi_never_bid");
  });

  it("refunds a participant whose only bid landed after the bidding window closed", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);
    await join(roundId, "too-late", "pi_too_late");
    await db.insert(bids).values({ roundId, bidderId: "too-late", amountCents: 11_000, placedAt: new Date(snapshotAt.getTime() + 1000) });
    const provider = new FakePaymentProvider();

    const result = await resolveBiddingPhaseSnapshot(roundId, snapshotAt, provider);
    expect(result.outcome).toBe("empty-closed");

    const [participant] = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    expect(participant.depositStatus).toBe("refunded");
    expect(provider.refunds).toContain("pi_too_late");
  });

  it("creates a payment offer for the snapshot leader when the queue is non-empty", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    await join(roundId, "a", "pi_a");
    const [bid] = await db
      .insert(bids)
      .values({ roundId, bidderId: "a", amountCents: 11_000, placedAt: new Date(startsAt.getTime() + 1000) })
      .returning();
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);

    const result = await resolveBiddingPhaseSnapshot(roundId, snapshotAt, new FakePaymentProvider());
    expect(result.outcome).toBe("offer-created");
    if (result.outcome !== "offer-created") throw new Error("expected offer");

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("payment");

    const [offer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, result.offerId));
    expect(offer.bidId).toBe(bid.id);
    expect(offer.status).toBe("pending");
    expect(offer.expiresAt.getTime()).toBe(Math.min(snapshotAt.getTime() + PAYMENT_ATTEMPT_MS, startsAt.getTime() + ROUND_MS));
  });

  it("a second concurrent call for the same round is a safe no-op — never creates two payment offers", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    await join(roundId, "a", "pi_a");
    await db.insert(bids).values({ roundId, bidderId: "a", amountCents: 11_000, placedAt: new Date(startsAt.getTime() + 1000) });
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);

    const [first, second] = await Promise.all([
      resolveBiddingPhaseSnapshot(roundId, snapshotAt, new FakePaymentProvider()),
      resolveBiddingPhaseSnapshot(roundId, snapshotAt, new FakePaymentProvider()),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["already-resolving", "offer-created"]);

    const offers = await db.select().from(paymentOffers).where(eq(paymentOffers.roundId, roundId));
    expect(offers).toHaveLength(1);
  });

  it("refunds and closes instead of offering when the payment window has already elapsed", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    await join(roundId, "leader", "pi_leader");
    await join(roundId, "runner-up", "pi_runner");
    await db.insert(bids).values([
      { roundId, bidderId: "leader", amountCents: 11_000, placedAt: new Date(startsAt.getTime() + 1000) },
      { roundId, bidderId: "runner-up", amountCents: 10_500, placedAt: new Date(startsAt.getTime() + 500) },
    ]);
    const lateSnapshot = new Date(startsAt.getTime() + ROUND_MS + PAYMENT_ATTEMPT_MS);
    const provider = new FakePaymentProvider();

    const result = await resolveBiddingPhaseSnapshot(roundId, lateSnapshot, provider);
    expect(result.outcome).toBe("empty-closed");

    const offers = await db.select().from(paymentOffers).where(eq(paymentOffers.roundId, roundId));
    expect(offers).toHaveLength(0);

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("closed");

    const participants = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    expect(participants.every((p) => p.depositStatus === "refunded")).toBe(true);
    expect(provider.refunds.sort()).toEqual(["pi_leader", "pi_runner"]);

    const allBans = await db.select().from(bans);
    expect(allBans).toHaveLength(0);
  });

  it("ignores a bid placed after the bidding window closed when picking the snapshot leader", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);
    await join(roundId, "honest", "pi_honest");
    const [inWindow] = await db
      .insert(bids)
      .values({ roundId, bidderId: "honest", amountCents: 11_000, placedAt: new Date(startsAt.getTime() + 1000) })
      .returning();
    await join(roundId, "sniper", "pi_sniper");
    await db.insert(bids).values({ roundId, bidderId: "sniper", amountCents: 99_000, placedAt: new Date(snapshotAt.getTime() + 1000) });

    const result = await resolveBiddingPhaseSnapshot(roundId, snapshotAt, new FakePaymentProvider());
    expect(result.outcome).toBe("offer-created");
    if (result.outcome !== "offer-created") throw new Error("expected offer");

    const [offer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, result.offerId));
    expect(offer.bidId).toBe(inWindow.id);
  });
});
