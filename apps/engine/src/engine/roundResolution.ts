import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { rounds, paymentOffers, bids, bans, roundParticipants } from "../db/schema";
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
): Promise<
  | { outcome: "empty-closed" }
  | { outcome: "already-resolving" }
  | { outcome: "offer-created"; offerId: string }
> {
  // Claim-before-snapshot: symmetric to attemptOfferPayment's claim-before-charge
  // guard below. Without this, two overlapping scheduler ticks (or two worker
  // instances) both seeing phase = "bidding" would both proceed, each creating
  // its own paymentOffers row for the same round.
  const claimed = await db
    .update(rounds)
    .set({ phase: "resolving" })
    .where(and(eq(rounds.id, roundId), eq(rounds.phase, "bidding")))
    .returning();

  if (claimed.length === 0) {
    // Someone else is already resolving this round (or it is past "bidding"
    // altogether). Deliberately NOT "empty-closed": that outcome tells the
    // caller the round reached a terminal state and the next round should be
    // started. Losing the claim race means the winner of that race owns the
    // round's fate — this call must do nothing at all.
    return { outcome: "already-resolving" };
  }
  const round = claimed[0];

  // asOf pins the queue to the bidding window: a bid placed after the window
  // closed can never win the snapshot, even if it somehow slipped past
  // placeBid's window guard.
  const leader = await getQueueLeader(roundId, snapshotAt);

  if (!leader) {
    // Refund, don't just close. Deposits live on roundParticipants now and are
    // decoupled from bidding: an empty queue no longer implies there is no
    // money to give back. Someone can join (and be charged) without ever
    // placing a bid — or place every bid after snapshotAt, which getQueueLeader's
    // asOf filters out — and closing the round bare would strand their deposit
    // at "held" permanently, since no other path in the engine ever refunds it.
    await closeRoundAndRefundHeld(roundId, provider);
    return { outcome: "empty-closed" };
  }

  const roundBoundary = new Date(round.startsAt.getTime() + ROUND_MS);
  const attemptExpiry = new Date(snapshotAt.getTime() + PAYMENT_ATTEMPT_MS);
  const expiresAt = attemptExpiry.getTime() < roundBoundary.getTime() ? attemptExpiry : roundBoundary;

  if (expiresAt.getTime() <= executedAt.getTime()) {
    // The scheduler is running late enough that the payment offer would be born
    // already expired — an infrastructure failure, not a bidder failure. Hand
    // nobody an offer, give every held deposit in the round back, and close
    // the round in the same terminal state as an empty one.
    await closeRoundAndRefundHeld(roundId, provider);
    return { outcome: "empty-closed" };
  }

  const [offer] = await db
    .insert(paymentOffers)
    .values({
      roundId,
      bidId: leader.id,
      offeredAt: snapshotAt,
      expiresAt,
      status: "pending",
    })
    .returning();
  await db.update(rounds).set({ phase: "payment" }).where(eq(rounds.id, roundId));

  return { outcome: "offer-created", offerId: offer.id };
}

// Attempts the off-session remainder charge for one payment offer and settles
// it fully, one way or the other:
//   - "paid": the charge succeeded — champion installed, other held deposits
//     refunded.
//   - "cascaded": the charge failed (declined or requires_action — treated
//     identically) — this bidder is forfeited and banned, and the next-highest
//     still-held bid gets its own new pending offer (nextOfferId).
//   - "round-closed": the charge failed and there was nobody left to cascade
//     to, or the round's own boundary had already passed.
//   - "already-processed": a concurrent call already claimed this offer.
//
// Replaces the old confirmPayment/resolveExpiredOffer split — see this
// plan's Task 7 rationale for why that split no longer applies now that the
// remainder charge is automatic and off-session instead of something a
// human confirms interactively.
export async function attemptOfferPayment(
  offerId: string,
  now: Date,
  provider: PaymentProvider,
  onInstalled?: (occupantId: string) => void,
): Promise<
  | { outcome: "paid" }
  | { outcome: "cascaded"; nextOfferId: string }
  | { outcome: "round-closed" }
  | { outcome: "already-processed" }
> {
  // Claim-before-charge: this single conditional UPDATE is what makes concurrent
  // duplicate calls safe — a second concurrent UPDATE targeting the same row
  // blocks until the first commits, then re-evaluates `status = 'pending'`
  // against the now-"processing" row and affects 0 rows.
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

  const [round] = await db.select().from(rounds).where(eq(rounds.id, offer.roundId)).limit(1);
  if (!round) throw new Error("Round not found.");

  const [participant] = await db
    .select()
    .from(roundParticipants)
    .where(and(eq(roundParticipants.roundId, offer.roundId), eq(roundParticipants.bidderId, bid.bidderId)))
    .limit(1);
  if (!participant) throw new Error("Round participant not found for offer's bidder.");

  const remainderCents = bid.amountCents - participant.depositCents;
  const chargeResult = await provider.chargeRemainderOffSession(participant.paymentMethodRef, remainderCents);

  if (chargeResult === "succeeded") {
    await db.update(paymentOffers).set({ status: "paid" }).where(eq(paymentOffers.id, offerId));
    await db.update(rounds).set({ phase: "closed" }).where(eq(rounds.id, offer.roundId));
    // "applied", not "refunded": the winner's deposit is credited toward the
    // final price (the charge is amount - deposit), it is never given back.
    await db.update(roundParticipants).set({ depositStatus: "applied" }).where(eq(roundParticipants.id, participant.id));

    const otherParticipants = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, offer.roundId));
    for (const other of otherParticipants) {
      // Only refund participants still "held" — one already forfeited in an
      // earlier cascade step must stay forfeited; refunding it here would
      // un-do the non-payment penalty for a banned bidder.
      if (other.id === participant.id || other.depositStatus !== "held") continue;
      await provider.refund(other.depositRef);
      await db.update(roundParticipants).set({ depositStatus: "refunded" }).where(eq(roundParticipants.id, other.id));
    }

    await installChampion(bid.bidderId, bid.amountCents, now, onInstalled);
    return { outcome: "paid" };
  }

  // chargeResult is "requires_action" or "failed" — both treated as
  // non-payment. Per the approved design, a bank requiring extra
  // authentication is not special-cased into a grace period; it bans exactly
  // like an outright decline, since building a retry/notification path is
  // explicitly out of scope for this feature.
  //
  // Stamp the offer terminal first — "processing" means "a charge is in
  // flight for this offer", and the charge is now definitively over. Leaving
  // it there would make a declined offer indistinguishable from one whose
  // worker died mid-attempt, which is exactly the distinction any
  // crash-recovery reaper needs. Applies to both branches below (cascade and
  // round-closed); "expired" is the same terminal status the pre-rework
  // resolveExpiredOffer used for non-payment.
  await db.update(paymentOffers).set({ status: "expired" }).where(eq(paymentOffers.id, offerId));
  await db.update(roundParticipants).set({ depositStatus: "forfeited" }).where(eq(roundParticipants.id, participant.id));
  await db.insert(bans).values({ bidderId: bid.bidderId, bannedUntil: new Date(now.getTime() + BAN_DURATION_MS) });

  const roundBoundary = new Date(round.startsAt.getTime() + ROUND_MS);
  if (now.getTime() >= roundBoundary.getTime()) {
    await closeRoundAndRefundHeld(round.id, provider, participant.id);
    return { outcome: "round-closed" };
  }

  const biddingClosedAt = new Date(round.startsAt.getTime() + BIDDING_PHASE_MS);
  const remainingBids = await db.select().from(bids).where(eq(bids.roundId, offer.roundId));
  const heldParticipants = await db
    .select()
    .from(roundParticipants)
    .where(and(eq(roundParticipants.roundId, offer.roundId), eq(roundParticipants.depositStatus, "held")));
  const heldBidderIds = new Set(heldParticipants.map((p) => p.bidderId));

  // Same window pin as the snapshot's `asOf`: a bid placed after the bidding
  // window closed must not be able to win the round through the cascade either.
  const nextCandidates = remainingBids.filter(
    (b) => b.id !== offer.bidId && heldBidderIds.has(b.bidderId) && b.placedAt.getTime() <= biddingClosedAt.getTime(),
  );
  nextCandidates.sort((a, b) => b.amountCents - a.amountCents || a.placedAt.getTime() - b.placedAt.getTime());
  const next = nextCandidates[0];

  if (!next) {
    await closeRoundAndRefundHeld(round.id, provider, participant.id);
    return { outcome: "round-closed" };
  }

  const attemptExpiry = new Date(now.getTime() + PAYMENT_ATTEMPT_MS);
  const nextExpiresAt = attemptExpiry.getTime() < roundBoundary.getTime() ? attemptExpiry : roundBoundary;

  const [nextOffer] = await db
    .insert(paymentOffers)
    .values({
      roundId: round.id,
      bidId: next.id,
      offeredAt: now,
      // expiresAt is retained for the scheduler's crash-recovery poll (Task 8)
      // but is not expected to be reached in normal operation — settleRound
      // attempts this new offer immediately, in the same call chain.
      expiresAt: nextExpiresAt,
      status: "pending",
    })
    .returning();

  return { outcome: "cascaded", nextOfferId: nextOffer.id };
}

// Attempts offerId and, on a cascade, immediately attempts the next offer too
// — repeating until the round is settled. This is what a caller should use
// in practice; attemptOfferPayment on its own only performs a single step.
export async function settleRound(
  offerId: string,
  now: Date,
  provider: PaymentProvider,
  onInstalled?: (occupantId: string) => void,
): Promise<{ outcome: "paid" } | { outcome: "round-closed" }> {
  let currentOfferId = offerId;
  for (;;) {
    const result = await attemptOfferPayment(currentOfferId, now, provider, onInstalled);
    if (result.outcome === "paid" || result.outcome === "round-closed") {
      return result;
    }
    if (result.outcome === "already-processed") {
      // A concurrent settleRound (or the scheduler's crash-recovery poll)
      // already claimed this offer — nothing more for this call to do.
      return { outcome: "round-closed" };
    }
    currentOfferId = result.nextOfferId;
  }
}

// Closes the round and gives back every deposit still "held" on it. A
// participant that already forfeited (a non-payer earlier in the cascade) or
// was already refunded is left alone — depositStatus !== "held" already
// guards that; excludeParticipantId is a belt-and-suspenders extra for the
// participant whose forfeit just happened moments earlier in the same call.
async function closeRoundAndRefundHeld(
  roundId: string,
  provider: PaymentProvider,
  excludeParticipantId?: string,
): Promise<void> {
  await db.update(rounds).set({ phase: "closed" }).where(eq(rounds.id, roundId));

  const remaining = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
  for (const p of remaining) {
    if (p.id === excludeParticipantId || p.depositStatus !== "held") continue;
    await provider.refund(p.depositRef);
    await db.update(roundParticipants).set({ depositStatus: "refunded" }).where(eq(roundParticipants.id, p.id));
  }
}
