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
  await resolveBiddingPhaseSnapshot(round.id, snapshotAt, new FakePaymentProvider());
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

  it("marks the winner's own deposit 'applied', not 'refunded' — it was credited, not returned", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { bid, offer } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();

    await confirmPayment(offer.id, new Date(offer.offeredAt.getTime() + 1000), provider);

    const [winningBid] = await db.select().from(bids).where(eq(bids.id, bid.id));
    expect(winningBid.depositStatus).toBe("applied");
    // The remainder charge is amount - deposit, so no money went back.
    expect(provider.refunds).not.toContain(bid.depositRef);
    expect(provider.remainderCharges[0].amountCents).toBe(bid.amountCents - bid.depositCents);
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

  it("picks the exact next-highest bid under an amount-desc/placedAt-asc tie-break with 3+ candidates", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offer, snapshotAt } = await seedRoundWithOffer(startsAt, 11_000);
    // Two bids tie at 10_500 — the earlier-placed one must win the tie-break —
    // plus a third, lower bid that must NOT be picked despite being a valid
    // "some other bid" (this is what the old "not equal to the forfeited bid"
    // assertion could not catch).
    const [laterTie] = await db
      .insert(bids)
      .values({ roundId, bidderId: "tie-later", amountCents: 10_500, depositCents: 1_050, depositRef: "tie-later-dep", placedAt: new Date(startsAt.getTime() + 700) })
      .returning();
    const [earlierTie] = await db
      .insert(bids)
      .values({ roundId, bidderId: "tie-earlier", amountCents: 10_500, depositCents: 1_050, depositRef: "tie-earlier-dep", placedAt: new Date(startsAt.getTime() + 500) })
      .returning();
    await db.insert(bids).values({
      roundId, bidderId: "low-bidder", amountCents: 10_000, depositCents: 1_000, depositRef: "low-dep", placedAt: new Date(startsAt.getTime() + 100),
    });
    const provider = new FakePaymentProvider();
    const expiry = new Date(Math.min(snapshotAt.getTime() + PAYMENT_ATTEMPT_MS, startsAt.getTime() + ROUND_MS));

    const result = await resolveExpiredOffer(offer.id, expiry, provider);
    expect(result.outcome).toBe("cascaded");

    const [newOffer] = await db.select().from(paymentOffers).where(eq(paymentOffers.status, "pending"));
    expect(newOffer.bidId).toBe(earlierTie.id);
    expect(newOffer.bidId).not.toBe(laterTie.id);
  });

  it("never cascades to a bid placed after the bidding window closed", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offer, snapshotAt } = await seedRoundWithOffer(startsAt, 11_000);
    const [inWindow] = await db
      .insert(bids)
      .values({ roundId, bidderId: "in-window", amountCents: 10_500, depositCents: 1_050, depositRef: "in-dep", placedAt: new Date(startsAt.getTime() + 500) })
      .returning();
    // Higher, but placed after the window closed — it must not win the round
    // through the cascade any more than it could win the snapshot.
    await db.insert(bids).values({
      roundId, bidderId: "late", amountCents: 20_000, depositCents: 2_000, depositRef: "late-dep", placedAt: new Date(snapshotAt.getTime() + 1000),
    });
    const provider = new FakePaymentProvider();
    const expiry = new Date(Math.min(snapshotAt.getTime() + PAYMENT_ATTEMPT_MS, startsAt.getTime() + ROUND_MS));

    const result = await resolveExpiredOffer(offer.id, expiry, provider);
    expect(result.outcome).toBe("cascaded");

    const [newOffer] = await db.select().from(paymentOffers).where(eq(paymentOffers.status, "pending"));
    expect(newOffer.bidId).toBe(inWindow.id);
  });

  it("a second concurrent call for the same offer is a safe no-op — only one ban row and one cascade result", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offer, snapshotAt } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(bids).values({
      roundId, bidderId: "second-in-line", amountCents: 10_500, depositCents: 1_050, depositRef: "second-dep", placedAt: new Date(startsAt.getTime() + 500),
    });
    const provider = new FakePaymentProvider();
    const expiry = new Date(Math.min(snapshotAt.getTime() + PAYMENT_ATTEMPT_MS, startsAt.getTime() + ROUND_MS));

    const [first, second] = await Promise.all([
      resolveExpiredOffer(offer.id, expiry, provider),
      resolveExpiredOffer(offer.id, expiry, provider),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["already-processed", "cascaded"]);

    const allBans = await db.select().from(bans).where(eq(bans.bidderId, "a"));
    expect(allBans).toHaveLength(1);

    const pendingOffers = await db.select().from(paymentOffers).where(eq(paymentOffers.status, "pending"));
    expect(pendingOffers).toHaveLength(1);
  });
});

describe("cross-cutting: cascade then payment must not un-forfeit the earlier non-payer", () => {
  it("does not refund a deposit already forfeited by an earlier cascade step when the eventual winner pays", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offer, snapshotAt } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(bids).values({
      roundId, bidderId: "second-in-line", amountCents: 10_500, depositCents: 1_050, depositRef: "second-dep", placedAt: new Date(startsAt.getTime() + 500),
    });
    const provider = new FakePaymentProvider();
    const expiry = new Date(Math.min(snapshotAt.getTime() + PAYMENT_ATTEMPT_MS, startsAt.getTime() + ROUND_MS));

    const cascadeResult = await resolveExpiredOffer(offer.id, expiry, provider);
    expect(cascadeResult.outcome).toBe("cascaded");

    const [newOffer] = await db.select().from(paymentOffers).where(eq(paymentOffers.status, "pending"));
    const payResult = await confirmPayment(newOffer.id, new Date(expiry.getTime() + 1000), provider);
    expect(payResult.outcome).toBe("paid");

    // Bidder "a" already forfeited their deposit for failing to pay — that must
    // stay forfeited even though bidder "second-in-line" (the cascade target)
    // went on to pay successfully.
    expect(provider.refunds).not.toContain("d1");
    const [forfeitedBid] = await db.select().from(bids).where(eq(bids.bidderId, "a"));
    expect(forfeitedBid.depositStatus).toBe("forfeited");
  });
});
