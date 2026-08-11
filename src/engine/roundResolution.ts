import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { rounds, paymentOffers, bids, bans } from "../db/schema";
import { getQueueLeader } from "../db/repository";
import { installChampion } from "./installChampion";
import { PAYMENT_ATTEMPT_MS, ROUND_MS, BAN_DURATION_MS } from "../domain/config";
import type { PaymentProvider } from "../payments/PaymentProvider";

export async function resolveBiddingPhaseSnapshot(
  roundId: string,
  now: Date,
): Promise<{ outcome: "empty-closed" | "offer-created" }> {
  const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId)).limit(1);
  if (!round) throw new Error("Round not found.");

  const leader = await getQueueLeader(roundId);

  if (!leader) {
    await db.update(rounds).set({ phase: "closed" }).where(eq(rounds.id, roundId));
    return { outcome: "empty-closed" };
  }

  const roundBoundary = new Date(round.startsAt.getTime() + ROUND_MS);
  const attemptExpiry = new Date(now.getTime() + PAYMENT_ATTEMPT_MS);
  const expiresAt = attemptExpiry.getTime() < roundBoundary.getTime() ? attemptExpiry : roundBoundary;

  await db.insert(paymentOffers).values({
    roundId,
    bidId: leader.id,
    offeredAt: now,
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
  await db.update(bids).set({ depositStatus: "refunded" }).where(eq(bids.id, bid.id));

  const otherBids = await db.select().from(bids).where(eq(bids.roundId, offer.roundId));
  for (const other of otherBids) {
    if (other.id === bid.id) continue;
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
): Promise<{ outcome: "cascaded" | "round-closed" }> {
  const [offer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, offerId)).limit(1);
  if (!offer) throw new Error("Payment offer not found.");

  const [round] = await db.select().from(rounds).where(eq(rounds.id, offer.roundId)).limit(1);
  if (!round) throw new Error("Round not found.");

  const [failedBid] = await db.select().from(bids).where(eq(bids.id, offer.bidId)).limit(1);

  await db.update(paymentOffers).set({ status: "expired" }).where(eq(paymentOffers.id, offerId));
  await db.update(bids).set({ depositStatus: "forfeited" }).where(eq(bids.id, offer.bidId));
  await db.insert(bans).values({ bidderId: failedBid.bidderId, bannedUntil: new Date(now.getTime() + BAN_DURATION_MS) });

  const roundBoundary = new Date(round.startsAt.getTime() + ROUND_MS);
  if (now.getTime() >= roundBoundary.getTime()) {
    return closeRoundAndRefundRemaining(round.id, offer.bidId, provider, "round-closed");
  }

  const remainingBids = await db
    .select()
    .from(bids)
    .where(eq(bids.roundId, offer.roundId));
  const nextCandidates = remainingBids.filter((b) => b.id !== offer.bidId && b.depositStatus === "held");
  nextCandidates.sort((a, b) => b.amountCents - a.amountCents || a.placedAt.getTime() - b.placedAt.getTime());
  const next = nextCandidates[0];

  if (!next) {
    return closeRoundAndRefundRemaining(round.id, offer.bidId, provider, "round-closed");
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

async function closeRoundAndRefundRemaining(
  roundId: string,
  excludeBidId: string,
  provider: PaymentProvider,
  outcome: "round-closed",
): Promise<{ outcome: "round-closed" }> {
  await db.update(rounds).set({ phase: "closed" }).where(eq(rounds.id, roundId));

  const remaining = await db.select().from(bids).where(eq(bids.roundId, roundId));
  for (const b of remaining) {
    if (b.id === excludeBidId || b.depositStatus !== "held") continue;
    await provider.refund(b.depositRef);
    await db.update(bids).set({ depositStatus: "refunded" }).where(eq(bids.id, b.id));
  }

  return { outcome };
}
