import { getCurrentReign, getLatestRound, getQueueLeader } from "../db/repository";
import { validateBidAmount } from "../domain/bidValidation";
import { nextDailyCloseAt } from "../domain/dailyClose";

// Mirrors the authoritative check inside recordBidAtomic: a round keeps phase
// "bidding" from T0 until the scheduler's tick actually snapshots it, which
// can be well after the round's actual close time. Phase alone is not
// authoritative for whether the round is actually still open.
// Exported so the HTTP bid route can apply the same window test *before*
// creating a PaymentIntent — otherwise every click on a stale page puts a
// hold on a bidder's card for a bid that just gets released a moment later,
// turning the race-release path into the normal path.
export function isBiddingOpen(round: { phase: string; startsAt: Date }, now: Date): boolean {
  if (round.phase !== "bidding") return false;
  const biddingClosesAt = nextDailyCloseAt(round.startsAt).getTime();
  return round.startsAt.getTime() <= now.getTime() && now.getTime() < biddingClosesAt;
}

// A fast, pre-authorization sanity check the API route runs before creating a
// PaymentIntent for a bid. Not authoritative — the real check happens inside
// recordBidAtomic once the hold is actually in place (state can change
// between this check and that one) — this only exists so an obviously
// doomed bid (stale page, already outbid, already leading) never reaches
// Stripe at all.
export async function prepareBid(
  params: { bidderId: string; amountCents: number; now: Date },
): Promise<{ ok: true; roundId: string } | { ok: false; reason: string }> {
  const reign = await getCurrentReign();
  if (!reign) return { ok: false, reason: "No active reign — the auction hasn't been bootstrapped yet." };

  const round = await getLatestRound(reign.id);
  if (!round || !isBiddingOpen(round, params.now)) {
    return { ok: false, reason: "This round is not accepting bids right now." };
  }

  const topBid = await getQueueLeader(round.id);
  if (topBid && topBid.bidderId === params.bidderId) {
    return { ok: false, reason: "You are already the current leader — wait to be outbid before raising your own bid." };
  }

  const currentLeaderCents = topBid ? topBid.amountCents : reign.priceCents;
  const validation = validateBidAmount(params.amountCents, currentLeaderCents);
  if (!validation.valid) return { ok: false, reason: validation.reason };

  return { ok: true, roundId: round.id };
}
