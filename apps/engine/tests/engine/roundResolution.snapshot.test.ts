import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans, paymentOffers } from "../../src/db/schema";
import { resolveBiddingPhaseSnapshot } from "../../src/engine/roundResolution";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";
import { eq } from "drizzle-orm";
import { PAYMENT_ATTEMPT_MS, ROUND_MS, BIDDING_PHASE_MS } from "../../src/domain/config";

afterEach(async () => {
  await db.delete(paymentOffers);
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

  it("creates a payment offer for the snapshot leader when the queue is non-empty", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    const [bid] = await db
      .insert(bids)
      .values({ roundId, bidderId: "a", amountCents: 11_000, depositCents: 1_100, depositRef: "d1", placedAt: new Date(startsAt.getTime() + 1000) })
      .returning();
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);

    const result = await resolveBiddingPhaseSnapshot(roundId, snapshotAt, new FakePaymentProvider());
    expect(result.outcome).toBe("offer-created");

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("payment");

    const [offer] = await db.select().from(paymentOffers).where(eq(paymentOffers.roundId, roundId));
    expect(offer.bidId).toBe(bid.id);
    expect(offer.status).toBe("pending");
    // 1h attempt window, bounded by the round's own 24h boundary — here the 1h window is the tighter bound.
    expect(offer.expiresAt.getTime()).toBe(Math.min(snapshotAt.getTime() + PAYMENT_ATTEMPT_MS, startsAt.getTime() + ROUND_MS));
  });

  it("a second concurrent call for the same round is a safe no-op — never creates two payment offers", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    await db.insert(bids).values({
      roundId, bidderId: "a", amountCents: 11_000, depositCents: 1_100, depositRef: "d1", placedAt: new Date(startsAt.getTime() + 1000),
    });
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
    // The scheduler was down long enough that the offer this snapshot would
    // create is born already-expired: the same tick's expiry loop would forfeit
    // the leader's deposit and ban them for 3 rounds, for an outage they had
    // nothing to do with. Infrastructure failure — no forfeiture, no ban.
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    await db.insert(bids).values([
      { roundId, bidderId: "leader", amountCents: 11_000, depositCents: 1_100, depositRef: "d1", placedAt: new Date(startsAt.getTime() + 1000) },
      { roundId, bidderId: "runner-up", amountCents: 10_500, depositCents: 1_050, depositRef: "d2", placedAt: new Date(startsAt.getTime() + 500) },
    ]);
    // Past the round boundary, so expiresAt (clamped to the boundary) <= now.
    const lateSnapshot = new Date(startsAt.getTime() + ROUND_MS + PAYMENT_ATTEMPT_MS);
    const provider = new FakePaymentProvider();

    const result = await resolveBiddingPhaseSnapshot(roundId, lateSnapshot, provider);
    expect(result.outcome).toBe("empty-closed");

    const offers = await db.select().from(paymentOffers).where(eq(paymentOffers.roundId, roundId));
    expect(offers).toHaveLength(0);

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("closed");

    const [leaderBid] = await db.select().from(bids).where(eq(bids.bidderId, "leader"));
    expect(leaderBid.depositStatus).toBe("refunded");
    const [runnerUpBid] = await db.select().from(bids).where(eq(bids.bidderId, "runner-up"));
    expect(runnerUpBid.depositStatus).toBe("refunded");
    expect(provider.refunds.sort()).toEqual(["d1", "d2"]);

    const allBans = await db.select().from(bans);
    expect(allBans).toHaveLength(0);
  });

  it("ignores a bid placed after the bidding window closed when picking the snapshot leader", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);
    const [inWindow] = await db
      .insert(bids)
      .values({ roundId, bidderId: "honest", amountCents: 11_000, depositCents: 1_100, depositRef: "d1", placedAt: new Date(startsAt.getTime() + 1000) })
      .returning();
    // A higher bid that somehow landed after the window closed must not win.
    await db.insert(bids).values({
      roundId, bidderId: "sniper", amountCents: 99_000, depositCents: 9_900, depositRef: "d2", placedAt: new Date(snapshotAt.getTime() + 1000),
    });

    const result = await resolveBiddingPhaseSnapshot(roundId, snapshotAt, new FakePaymentProvider());
    expect(result.outcome).toBe("offer-created");

    const [offer] = await db.select().from(paymentOffers).where(eq(paymentOffers.roundId, roundId));
    expect(offer.bidId).toBe(inWindow.id);
  });
});
