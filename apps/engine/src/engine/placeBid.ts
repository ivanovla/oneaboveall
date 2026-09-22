import { getCurrentReign, getLatestRound, getQueueLeader, isBanned, getRoundParticipant, placeBidAtomic } from "../db/repository";
import { validateBidAmount } from "../domain/bidValidation";
import { BIDDING_PHASE_MS } from "../domain/config";

export async function placeBid(
  params: { bidderId: string; amountCents: number; now: Date },
): Promise<{ ok: true; bidId: string } | { ok: false; reason: string }> {
  if (await isBanned(params.bidderId, params.now)) {
    return { ok: false, reason: "This bidder is currently banned from placing bids." };
  }

  const reign = await getCurrentReign();
  if (!reign) return { ok: false, reason: "No active reign — the auction hasn't been bootstrapped yet." };

  const round = await getLatestRound(reign.id);
  const biddingClosesAt = round && new Date(round.startsAt.getTime() + BIDDING_PHASE_MS);
  if (
    !round ||
    !biddingClosesAt ||
    round.phase !== "bidding" ||
    round.startsAt > params.now ||
    params.now.getTime() >= biddingClosesAt.getTime()
  ) {
    // Both ends of the [T0, T0+12h) bidding window are enforced here — see the
    // original rationale preserved from before this rework: the scheduler opens
    // next-day rounds ahead of their startsAt (lower bound), and a round keeps
    // phase "bidding" until the scheduler's tick actually snapshots it (upper
    // bound); round.startsAt is immutable once inserted so plain comparisons
    // are sufficient here — no claim-guard race to worry about.
    return { ok: false, reason: "This round is not accepting bids right now." };
  }

  // Fast-path: a bidder who never joined (or a bid amount that's obviously too
  // low) never reaches placeBidAtomic's SERIALIZABLE transaction. Not
  // authoritative — both checks are re-verified for real inside
  // placeBidAtomic, which is what actually guards correctness under
  // concurrency.
  const participant = await getRoundParticipant(round.id, params.bidderId);
  if (!participant || participant.depositStatus !== "held") {
    return { ok: false, reason: "Join this round (pay the deposit) before placing a bid." };
  }

  const topBid = await getQueueLeader(round.id);
  const currentLeaderCents = topBid ? topBid.amountCents : reign.priceCents;
  const preValidation = validateBidAmount(params.amountCents, currentLeaderCents);
  if (!preValidation.valid) {
    return { ok: false, reason: preValidation.reason };
  }

  const result = await placeBidAtomic({
    roundId: round.id,
    bidderId: params.bidderId,
    amountCents: params.amountCents,
    placedAt: params.now,
  });

  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }

  return { ok: true, bidId: result.bid.id };
}
