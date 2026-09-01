import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { rounds, paymentOffers, bids, bans } from "../db/schema";
import { getQueueLeader } from "../db/repository";
import { installChampion } from "./installChampion";
import { PAYMENT_ATTEMPT_MS, ROUND_MS, BAN_DURATION_MS, BIDDING_PHASE_MS } from "../domain/config";
import type { PaymentProvider } from "../payments/PaymentProvider";

export async function resolveBiddingPhaseSnapshot(
  roundId: string,
  // The instant the bidding window closed on the ideal schedule grid
  // (round.startsAt + BIDDING_PHASE_MS). All derived deadlines are computed
  // from this so a late tick does not push the schedule around.
  snapshotAt: Date,
  provider: PaymentProvider,
  // The instant this resolution is actually running. Defaults to snapshotAt
  // (an on-time tick, and every direct caller that doesn't care); the scheduler
  // passes the real clock so a late tick can detect that the payment window it
  // is about to hand out has already elapsed.
  executedAt: Date = snapshotAt,
): Promise<{ outcome: "empty-closed" | "offer-created" | "already-resolving" }> {
  // Claim-before-snapshot: symmetric to confirmPayment's claim-before-charge and
  // resolveExpiredOffer's claim-before-expire guards. Without this, two overlapping
  // scheduler ticks (or two worker instances) both seeing phase = "bidding" would
  // both proceed, each creating its own paymentOffers row for the same round.
  const claimed = await db
    .update(rounds)
    .set({ phase: "resolving" })
    .where(and(eq(rounds.id, roundId), eq(rounds.phase, "bidding")))
    .returning();

  if (claimed.length === 0) {
    return { outcome: "already-resolving" };
  }
  const round = claimed[0];

  // asOf pins the queue to the bidding window: a bid placed after the window
  // closed can never win the snapshot, even if it somehow slipped past
  // placeBid's window guard.
  const leader = await getQueueLeader(roundId, snapshotAt);

  if (!leader) {
    await db.update(rounds).set({ phase: "closed" }).where(eq(rounds.id, roundId));
    return { outcome: "empty-closed" };
  }

  const roundBoundary = new Date(round.startsAt.getTime() + ROUND_MS);
  const attemptExpiry = new Date(snapshotAt.getTime() + PAYMENT_ATTEMPT_MS);
  const expiresAt = attemptExpiry.getTime() < roundBoundary.getTime() ? attemptExpiry : roundBoundary;

  if (expiresAt.getTime() <= executedAt.getTime()) {
    // The scheduler is running late enough that the payment offer would be born
    // already expired: the very next loop of this same tick would pick it up,
    // forfeit the leader's deposit and ban them for 3 rounds — punishing a
    // bidder who was never notified and never had a usable moment to pay. That
    // is an infrastructure failure, not a bidder failure. Hand nobody an offer,
    // give every held deposit in the round back, and close the round in the
    // same terminal state as an empty one (champion unchanged; the caller
    // starts the next day's round).
    await closeRoundAndRefundHeld(roundId, provider);
    return { outcome: "empty-closed" };
  }

  await db.insert(paymentOffers).values({
    roundId,
    bidId: leader.id,
    offeredAt: snapshotAt,
    expiresAt,
    status: "pending",
  });
  await db.update(rounds).set({ phase: "payment" }).where(eq(rounds.id, roundId));

  return { outcome: "offer-created" };
}

export async function confirmPayment(
  offerId: string,
  now: Date,
  provider: PaymentProvider,
  onInstalled?: (occupantId: string) => void,
): Promise<{ outcome: "paid" | "already-processed" }> {
  // Claim-before-charge: this single conditional UPDATE is what makes concurrent
  // duplicate calls safe. Postgres row-level locking means a second concurrent
  // UPDATE targeting the same row blocks until the first commits, then re-evaluates
  // `status = 'pending'` against the now-"processing" row and affects 0 rows — no
  // SERIALIZABLE isolation or retry loop needed for this pattern, unlike the
  // select-then-insert races in placeBidAtomic/createInitialReign/installChampion.
  const claimed = await db
    .update(paymentOffers)
    .set({ status: "processing" })
    .where(and(eq(paymentOffers.id, offerId), eq(paymentOffers.status, "pending")))
    .returning();

  if (claimed.length === 0) {
    return { outcome: "already-processed" };
  }
  const offer = claimed[0];

  const [bid] = await db.select().from(bids).where(eq(bids.id, offer.bidId)).limit(1);
  if (!bid) throw new Error("Bid not found for offer.");

  const remainderCents = bid.amountCents - bid.depositCents;
  const paid = await provider.chargeRemainder(bid.bidderId, remainderCents, bid.depositRef);
  if (!paid) {
    // Release the claim so a legitimate future attempt (or the scheduled expiry
    // cascade) can still process this offer — do not leave it stuck in "processing".
    await db.update(paymentOffers).set({ status: "pending" }).where(eq(paymentOffers.id, offerId));
    throw new Error("chargeRemainder returned false inside confirmPayment — caller should not confirm an unsuccessful charge.");
  }

  await db.update(paymentOffers).set({ status: "paid" }).where(eq(paymentOffers.id, offerId));
  await db.update(rounds).set({ phase: "closed" }).where(eq(rounds.id, offer.roundId));
  // "applied", not "refunded": the winner's deposit is credited toward the
  // final price (chargeRemainder bills amount - deposit), it is never given
  // back. Labelling it "refunded" would overstate refunds in any accounting
  // rollup over deposit_status by exactly the winning deposit, every round.
  await db.update(bids).set({ depositStatus: "applied" }).where(eq(bids.id, bid.id));

  const otherBids = await db.select().from(bids).where(eq(bids.roundId, offer.roundId));
  for (const other of otherBids) {
    // Only refund bids still "held" — a bid that already forfeited its deposit
    // in an earlier cascade step (Finding 1, Task 12 review) must stay forfeited;
    // refunding it here would un-do the non-payment penalty for a banned bidder.
    if (other.id === bid.id || other.depositStatus !== "held") continue;
    await provider.refund(other.depositRef);
    await db.update(bids).set({ depositStatus: "refunded" }).where(eq(bids.id, other.id));
  }

  await installChampion(bid.bidderId, bid.amountCents, now, onInstalled);

  return { outcome: "paid" };
}

export async function resolveExpiredOffer(
  offerId: string,
  now: Date,
  provider: PaymentProvider,
): Promise<{ outcome: "cascaded" | "round-closed" | "already-processed" }> {
  // Claim-before-expire: symmetric to confirmPayment's claim-before-charge guard
  // (Finding 2, Task 12 review). Without this, a payment landing in the same
  // instant the scheduler's tick expires the same offer would both succeed:
  // the payer gets installed as champion AND banned with a forfeited deposit,
  // and a duplicate cascade offer gets created on an already-closed round.
  const claimed = await db
    .update(paymentOffers)
    .set({ status: "expired" })
    .where(and(eq(paymentOffers.id, offerId), eq(paymentOffers.status, "pending")))
    .returning();

  if (claimed.length === 0) {
    return { outcome: "already-processed" };
  }
  const offer = claimed[0];

  const [round] = await db.select().from(rounds).where(eq(rounds.id, offer.roundId)).limit(1);
  if (!round) throw new Error("Round not found.");

  const [failedBid] = await db.select().from(bids).where(eq(bids.id, offer.bidId)).limit(1);

  await db.update(bids).set({ depositStatus: "forfeited" }).where(eq(bids.id, offer.bidId));
  await db.insert(bans).values({ bidderId: failedBid.bidderId, bannedUntil: new Date(now.getTime() + BAN_DURATION_MS) });

  const roundBoundary = new Date(round.startsAt.getTime() + ROUND_MS);
  if (now.getTime() >= roundBoundary.getTime()) {
    await closeRoundAndRefundHeld(round.id, provider, offer.bidId);
    return { outcome: "round-closed" };
  }

  const remainingBids = await db
    .select()
    .from(bids)
    .where(eq(bids.roundId, offer.roundId));
  // Same window pin as the snapshot's `asOf`: a bid placed after the bidding
  // window closed must not be able to win the round through the cascade either.
  const biddingClosedAt = new Date(round.startsAt.getTime() + BIDDING_PHASE_MS);
  const nextCandidates = remainingBids.filter(
    (b) => b.id !== offer.bidId && b.depositStatus === "held" && b.placedAt.getTime() <= biddingClosedAt.getTime(),
  );
  nextCandidates.sort((a, b) => b.amountCents - a.amountCents || a.placedAt.getTime() - b.placedAt.getTime());
  const next = nextCandidates[0];

  if (!next) {
    await closeRoundAndRefundHeld(round.id, provider, offer.bidId);
    return { outcome: "round-closed" };
  }

  const attemptExpiry = new Date(now.getTime() + PAYMENT_ATTEMPT_MS);
  const expiresAt = attemptExpiry.getTime() < roundBoundary.getTime() ? attemptExpiry : roundBoundary;

  await db.insert(paymentOffers).values({
    roundId: round.id,
    bidId: next.id,
    offeredAt: now,
    expiresAt,
    status: "pending",
  });

  return { outcome: "cascaded" };
}

// Closes the round and gives back every deposit still "held" on it. Bids that
// already forfeited (a non-payer earlier in the cascade) or were already
// refunded are left alone.
async function closeRoundAndRefundHeld(
  roundId: string,
  provider: PaymentProvider,
  excludeBidId?: string,
): Promise<void> {
  await db.update(rounds).set({ phase: "closed" }).where(eq(rounds.id, roundId));

  const remaining = await db.select().from(bids).where(eq(bids.roundId, roundId));
  for (const b of remaining) {
    if (b.id === excludeBidId || b.depositStatus !== "held") continue;
    await provider.refund(b.depositRef);
    await db.update(bids).set({ depositStatus: "refunded" }).where(eq(bids.id, b.id));
  }
}
