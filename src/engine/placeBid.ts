import { getCurrentReign, getLatestRound, getQueueLeader, isBanned, placeBidAtomic } from "../db/repository";
import { calculateDeposit } from "../domain/deposit";
import { validateBidAmount } from "../domain/bidValidation";
import { BIDDING_PHASE_MS } from "../domain/config";
import type { PaymentProvider } from "../payments/PaymentProvider";

export async function placeBid(
  params: { bidderId: string; amountCents: number; now: Date },
  provider: PaymentProvider,
): Promise<{ ok: true; bidId: string; depositCents: number } | { ok: false; reason: string }> {
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
    // Both ends of the [T0, T0+12h) bidding window are enforced here.
    //
    // Lower bound: the scheduler creates the next day's round (phase:
    // "bidding") as soon as the current round closes, but its startsAt is in
    // the future — the spec is explicit that bidding is not accepted until
    // that round actually opens.
    //
    // Upper bound: a round keeps phase "bidding" from T0+12h until the
    // scheduler's tick actually snapshots it. Without this check every bid
    // placed in that gap is accepted and can win the snapshot — a sniper
    // could wait for the window to visibly close and then bid.
    //
    // round.startsAt is immutable once inserted, so these plain comparisons
    // are sufficient; no claim-guard race to worry about.
    return { ok: false, reason: "This round is not accepting bids right now." };
  }

  // Fast-path validation so an obviously-too-low bid never triggers a deposit
  // charge (and matching refund). This is not authoritative: it reads outside
  // the atomic transaction, so a concurrent bid could still move the leader
  // between this check and the insert below. placeBidAtomic re-validates the
  // amount for real, inside the SERIALIZABLE transaction, and that's the
  // check that actually guards correctness.
  const topBid = await getQueueLeader(round.id);
  const currentLeaderCents = topBid ? topBid.amountCents : reign.priceCents;
  const preValidation = validateBidAmount(params.amountCents, currentLeaderCents);
  if (!preValidation.valid) {
    return { ok: false, reason: preValidation.reason };
  }

  const depositCents = calculateDeposit(params.amountCents);
  const depositRef = await provider.chargeDeposit(params.bidderId, depositCents);

  let result: Awaited<ReturnType<typeof placeBidAtomic>>;
  try {
    result = await placeBidAtomic({
      roundId: round.id,
      bidderId: params.bidderId,
      amountCents: params.amountCents,
      depositCents,
      depositRef,
      placedAt: params.now,
    });
  } catch (err) {
    // The deposit is already charged at this point. Anything that throws out of
    // placeBidAtomic (a DB error, exhausted SERIALIZABLE retries, a constraint
    // violation) would otherwise strand the bidder's money with no bid to show
    // for it. Refund and report a failure — every other failure path in this
    // function returns { ok: false }, so callers get one consistent contract
    // instead of sometimes-throws.
    await provider.refund(depositRef);
    // The reason string is user-facing, so the raw error goes to the log rather
    // than to the bidder (same logging convention as the scheduler's tick).
    console.error(`placeBid: placeBidAtomic threw for bidder ${params.bidderId}; deposit ${depositRef} refunded`, err);
    return {
      ok: false,
      reason: "Bid placement failed after the deposit was charged; the deposit has been refunded. Please try again.",
    };
  }

  if (!result.ok) {
    await provider.refund(depositRef);
    return { ok: false, reason: result.reason };
  }

  return { ok: true, bidId: result.bid.id, depositCents };
}
