import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans, paymentOffers, roundParticipants } from "../../src/db/schema";
import { resolveBiddingPhaseSnapshot, attemptOfferPayment, settleRound } from "../../src/engine/roundResolution";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";
import { eq } from "drizzle-orm";
import { PAYMENT_ATTEMPT_MS, BIDDING_PHASE_MS, ROUND_MS } from "../../src/domain/config";

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

async function seedRoundWithOffer(startsAt: Date, bidAmount: number, depositCents = 1_000) {
  const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: startsAt }).returning();
  const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt, phase: "bidding" }).returning();
  await db.insert(roundParticipants).values({ roundId: round.id, bidderId: "a", depositCents, depositRef: "pi_a", paymentMethodRef: "pm_a" });
  const [bid] = await db
    .insert(bids)
    .values({ roundId: round.id, bidderId: "a", amountCents: bidAmount, placedAt: new Date(startsAt.getTime() + 1000) })
    .returning();
  const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);
  const snapshot = await resolveBiddingPhaseSnapshot(round.id, snapshotAt, new FakePaymentProvider());
  if (snapshot.outcome !== "offer-created") throw new Error("expected an offer to be created");
  return { reignId: reign.id, roundId: round.id, bid, offerId: snapshot.offerId, snapshotAt };
}

describe("attemptOfferPayment — success path", () => {
  it("installs the payer as the new champion and marks the offer paid", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, bid, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    const result = await attemptOfferPayment(offerId, now, provider);
    expect(result.outcome).toBe("paid");

    const [updatedOffer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, offerId));
    expect(updatedOffer.status).toBe("paid");

    const [updatedRound] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(updatedRound.phase).toBe("closed");

    expect(provider.remainderCharges).toHaveLength(1);
    expect(provider.remainderCharges[0].paymentMethodRef).toBe("pm_a");
    expect(provider.remainderCharges[0].amountCents).toBe(bid.amountCents - 1_000);
  });

  it("marks the winner's own deposit 'applied', not 'refunded' — it was credited, not returned", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    await attemptOfferPayment(offerId, now, provider);

    const [participant] = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    expect(participant.depositStatus).toBe("applied");
    expect(provider.refunds).not.toContain("pi_a");
  });

  it("refunds every other held participant in the round on payment", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(roundParticipants).values({ roundId, bidderId: "loser", depositCents: 1_050, depositRef: "pi_loser", paymentMethodRef: "pm_loser" });
    const provider = new FakePaymentProvider();
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    await attemptOfferPayment(offerId, now, provider);
    expect(provider.refunds).toContain("pi_loser");
  });

  it("a second concurrent call for the same offer is a safe no-op — never double-charges", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { offerId } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    const [first, second] = await Promise.all([
      attemptOfferPayment(offerId, now, provider),
      attemptOfferPayment(offerId, now, provider),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["already-processed", "paid"]);
    expect(provider.remainderCharges).toHaveLength(1);
  });
});

describe("attemptOfferPayment — failure path (forfeit, ban, cascade)", () => {
  it("forfeits the deposit, bans the bidder, and cascades to the next-highest bid when the off-session charge fails", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(roundParticipants).values({ roundId, bidderId: "second-in-line", depositCents: 1_050, depositRef: "pi_second", paymentMethodRef: "pm_second" });
    await db.insert(bids).values({ roundId, bidderId: "second-in-line", amountCents: 10_500, placedAt: new Date(startsAt.getTime() + 500) });
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed");
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    const result = await attemptOfferPayment(offerId, now, provider);
    expect(result.outcome).toBe("cascaded");
    if (result.outcome !== "cascaded") throw new Error("expected cascade");

    const [participant] = await db.select().from(roundParticipants).where(eq(roundParticipants.bidderId, "a"));
    expect(participant.depositStatus).toBe("forfeited");
    expect(provider.refunds).not.toContain("pi_a");

    const [ban] = await db.select().from(bans).where(eq(bans.bidderId, "a"));
    expect(ban).toBeDefined();

    const [newOffer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, result.nextOfferId));
    expect(newOffer.bidId).not.toBe((await db.select().from(bids).where(eq(bids.bidderId, "a")))[0].id);

    // The failed offer must reach a terminal status, not linger at
    // "processing" — that is what lets a reaper tell an actually-declined
    // charge apart from one still mid-flight.
    const [failedOffer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, offerId));
    expect(failedOffer.status).toBe("expired");
  });

  it("treats 'requires_action' identically to an outright decline — forfeit and ban, no special case", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("requires_action");
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    const result = await attemptOfferPayment(offerId, now, provider);
    expect(result.outcome).toBe("round-closed"); // no other bidder to cascade to

    const [ban] = await db.select().from(bans).where(eq(bans.bidderId, "a"));
    expect(ban).toBeDefined();
  });

  it("closes the round and refunds the rest when the queue is exhausted", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed");
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    const result = await attemptOfferPayment(offerId, now, provider);
    expect(result.outcome).toBe("round-closed");

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("closed");

    // Terminal status on the round-closing failure branch too, not just the
    // cascading one.
    const [failedOffer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, offerId));
    expect(failedOffer.status).toBe("expired");
  });

  it("closes the round instead of cascading once the round's own boundary has passed", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(roundParticipants).values({ roundId, bidderId: "second-in-line", depositCents: 1_050, depositRef: "pi_second", paymentMethodRef: "pm_second" });
    await db.insert(bids).values({ roundId, bidderId: "second-in-line", amountCents: 10_500, placedAt: new Date(startsAt.getTime() + 500) });
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed");
    const roundBoundary = new Date(startsAt.getTime() + ROUND_MS);

    const result = await attemptOfferPayment(offerId, roundBoundary, provider);
    expect(result.outcome).toBe("round-closed");

    const [second] = await db.select().from(roundParticipants).where(eq(roundParticipants.bidderId, "second-in-line"));
    expect(second.depositStatus).toBe("refunded"); // never got a turn — the round simply ran out of time
  });

  it("picks the exact next-highest bid under an amount-desc/placedAt-asc tie-break with 3+ candidates", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    for (const [bidderId, amountCents, offsetMs] of [
      ["tie-later", 10_500, 700],
      ["tie-earlier", 10_500, 500],
      ["low-bidder", 10_000, 100],
    ] as const) {
      await db.insert(roundParticipants).values({ roundId, bidderId, depositCents: 1_000, depositRef: `pi_${bidderId}`, paymentMethodRef: `pm_${bidderId}` });
      await db.insert(bids).values({ roundId, bidderId, amountCents, placedAt: new Date(startsAt.getTime() + offsetMs) });
    }
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed");
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    const result = await attemptOfferPayment(offerId, now, provider);
    expect(result.outcome).toBe("cascaded");
    if (result.outcome !== "cascaded") throw new Error("expected cascade");

    const [newOffer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, result.nextOfferId));
    const [earlierTieBid] = await db.select().from(bids).where(eq(bids.bidderId, "tie-earlier"));
    expect(newOffer.bidId).toBe(earlierTieBid.id);
  });

  it("never cascades to a bid placed after the bidding window closed", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId, snapshotAt } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(roundParticipants).values({ roundId, bidderId: "in-window", depositCents: 1_050, depositRef: "pi_in", paymentMethodRef: "pm_in" });
    const [inWindow] = await db.insert(bids).values({ roundId, bidderId: "in-window", amountCents: 10_500, placedAt: new Date(startsAt.getTime() + 500) }).returning();
    await db.insert(roundParticipants).values({ roundId, bidderId: "late", depositCents: 2_000, depositRef: "pi_late", paymentMethodRef: "pm_late" });
    await db.insert(bids).values({ roundId, bidderId: "late", amountCents: 20_000, placedAt: new Date(snapshotAt.getTime() + 1000) });
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed");

    const result = await attemptOfferPayment(offerId, new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000), provider);
    expect(result.outcome).toBe("cascaded");
    if (result.outcome !== "cascaded") throw new Error("expected cascade");

    const [newOffer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, result.nextOfferId));
    expect(newOffer.bidId).toBe(inWindow.id);
  });

  it("a second concurrent call for the same offer is a safe no-op — only one ban row and one cascade result", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(roundParticipants).values({ roundId, bidderId: "second-in-line", depositCents: 1_050, depositRef: "pi_second", paymentMethodRef: "pm_second" });
    await db.insert(bids).values({ roundId, bidderId: "second-in-line", amountCents: 10_500, placedAt: new Date(startsAt.getTime() + 500) });
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed");
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    const [first, second] = await Promise.all([
      attemptOfferPayment(offerId, now, provider),
      attemptOfferPayment(offerId, now, provider),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["already-processed", "cascaded"]);

    const allBans = await db.select().from(bans).where(eq(bans.bidderId, "a"));
    expect(allBans).toHaveLength(1);
  });
});

describe("cross-cutting: cascade then payment must not un-forfeit the earlier non-payer", () => {
  it("does not refund a deposit already forfeited by an earlier cascade step when the eventual winner pays", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(roundParticipants).values({ roundId, bidderId: "second-in-line", depositCents: 1_050, depositRef: "pi_second", paymentMethodRef: "pm_second" });
    await db.insert(bids).values({ roundId, bidderId: "second-in-line", amountCents: 10_500, placedAt: new Date(startsAt.getTime() + 500) });
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed");
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    const cascadeResult = await attemptOfferPayment(offerId, now, provider);
    expect(cascadeResult.outcome).toBe("cascaded");
    if (cascadeResult.outcome !== "cascaded") throw new Error("expected cascade");

    const payResult = await attemptOfferPayment(cascadeResult.nextOfferId, new Date(now.getTime() + 1000), provider);
    expect(payResult.outcome).toBe("paid");

    expect(provider.refunds).not.toContain("pi_a");
    const [forfeitedParticipant] = await db.select().from(roundParticipants).where(eq(roundParticipants.bidderId, "a"));
    expect(forfeitedParticipant.depositStatus).toBe("forfeited");
  });
});

describe("settleRound", () => {
  it("resolves straight to 'paid' when the first offer succeeds", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { offerId } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();

    const result = await settleRound(offerId, new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000), provider);
    expect(result.outcome).toBe("paid");
  });

  it("follows a cascade through to a later payer without the caller doing anything else", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(roundParticipants).values({ roundId, bidderId: "second-in-line", depositCents: 1_050, depositRef: "pi_second", paymentMethodRef: "pm_second" });
    await db.insert(bids).values({ roundId, bidderId: "second-in-line", amountCents: 10_500, placedAt: new Date(startsAt.getTime() + 500) });
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed"); // only the FIRST attempt (bidder "a") fails

    const result = await settleRound(offerId, new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000), provider);
    expect(result.outcome).toBe("paid");

    const [second] = await db.select().from(roundParticipants).where(eq(roundParticipants.bidderId, "second-in-line"));
    expect(second.depositStatus).toBe("applied");
  });

  it("resolves to 'round-closed' when every candidate fails", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { offerId } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed");

    const result = await settleRound(offerId, new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000), provider);
    expect(result.outcome).toBe("round-closed");
  });
});
