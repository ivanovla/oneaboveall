import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, paymentOffers } from "../../src/db/schema";
import { resolveBiddingPhaseSnapshot } from "../../src/engine/roundResolution";
import { eq } from "drizzle-orm";
import { PAYMENT_ATTEMPT_MS, ROUND_MS, BIDDING_PHASE_MS } from "../../src/domain/config";

afterEach(async () => {
  await db.delete(paymentOffers);
  await db.delete(bids);
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

    const result = await resolveBiddingPhaseSnapshot(roundId, snapshotAt);
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

    const result = await resolveBiddingPhaseSnapshot(roundId, snapshotAt);
    expect(result.outcome).toBe("offer-created");

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("payment");

    const [offer] = await db.select().from(paymentOffers).where(eq(paymentOffers.roundId, roundId));
    expect(offer.bidId).toBe(bid.id);
    expect(offer.status).toBe("pending");
    // 1h attempt window, bounded by the round's own 24h boundary — here the 1h window is the tighter bound.
    expect(offer.expiresAt.getTime()).toBe(Math.min(snapshotAt.getTime() + PAYMENT_ATTEMPT_MS, startsAt.getTime() + ROUND_MS));
  });
});
