import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans, paymentOffers } from "../../src/db/schema";
import { resolveBiddingPhaseSnapshot, confirmPayment, resolveExpiredOffer } from "../../src/engine/roundResolution";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";
import { eq } from "drizzle-orm";
import { PAYMENT_ATTEMPT_MS, BIDDING_PHASE_MS, ROUND_MS } from "../../src/domain/config";

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

async function seedRoundWithOffer(startsAt: Date, bidAmount: number) {
  const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: startsAt }).returning();
  const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt, phase: "bidding" }).returning();
  const [bid] = await db
    .insert(bids)
    .values({ roundId: round.id, bidderId: "a", amountCents: bidAmount, depositCents: 1_000, depositRef: "d1", placedAt: new Date(startsAt.getTime() + 1000) })
    .returning();
  const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);
  await resolveBiddingPhaseSnapshot(round.id, snapshotAt);
  const [offer] = await db.select().from(paymentOffers).where(eq(paymentOffers.roundId, round.id));
  return { reignId: reign.id, roundId: round.id, bid, offer, snapshotAt };
}

describe("confirmPayment", () => {
  it("installs the payer as the new champion and marks the offer paid", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, bid, offer } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    const now = new Date(offer.offeredAt.getTime() + 1000);

    const result = await confirmPayment(offer.id, now, provider);
    expect(result.outcome).toBe("paid");

    const [updatedOffer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, offer.id));
    expect(updatedOffer.status).toBe("paid");

    const [updatedRound] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(updatedRound.phase).toBe("closed");

    expect(provider.remainderCharges.some((c) => c.bidderId === bid.bidderId)).toBe(true);
  });

  it("refunds every other bid in the round on payment", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offer } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(bids).values({
      roundId, bidderId: "loser", amountCents: 10_500, depositCents: 1_050, depositRef: "loser-dep", placedAt: new Date(startsAt.getTime() + 500),
    });
    const provider = new FakePaymentProvider();
    await confirmPayment(offer.id, new Date(offer.offeredAt.getTime() + 1000), provider);
    expect(provider.refunds).toContain("loser-dep");
  });

  it("a second concurrent call for the same offer is a safe no-op — never double-charges", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { offer } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    const now = new Date(offer.offeredAt.getTime() + 1000);

    const [first, second] = await Promise.all([
      confirmPayment(offer.id, now, provider),
      confirmPayment(offer.id, now, provider),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["already-processed", "paid"]);
    expect(provider.remainderCharges).toHaveLength(1);
  });
});

describe("resolveExpiredOffer", () => {
  it("forfeits the deposit, bans the bidder, and cascades to the next-highest bid", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offer, snapshotAt } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(bids).values({
      roundId, bidderId: "second-in-line", amountCents: 10_500, depositCents: 1_050, depositRef: "second-dep", placedAt: new Date(startsAt.getTime() + 500),
    });
    const provider = new FakePaymentProvider();
    const expiry = new Date(Math.min(snapshotAt.getTime() + PAYMENT_ATTEMPT_MS, startsAt.getTime() + ROUND_MS));

    const result = await resolveExpiredOffer(offer.id, expiry, provider);
    expect(result.outcome).toBe("cascaded");

    const [firstBid] = await db.select().from(bids).where(eq(bids.bidderId, "a"));
    expect(firstBid.depositStatus).toBe("forfeited");
    expect(provider.refunds).not.toContain("d1");

    const [ban] = await db.select().from(bans).where(eq(bans.bidderId, "a"));
    expect(ban).toBeDefined();

    const [newOffer] = await db.select().from(paymentOffers).where(eq(paymentOffers.status, "pending"));
    expect(newOffer.bidId).not.toBe(offer.bidId);
  });

  it("closes the round and refunds the rest when the shared budget runs out", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offer } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    const roundBoundary = new Date(startsAt.getTime() + ROUND_MS);

    const result = await resolveExpiredOffer(offer.id, roundBoundary, provider);
    expect(result.outcome).toBe("round-closed");

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("closed");
  });
});
