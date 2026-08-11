import { getCurrentReign, getLatestRound, getQueueLeader, isBanned, placeBidAtomic } from "../db/repository";
import { calculateDeposit } from "../domain/deposit";
import { validateBidAmount } from "../domain/bidValidation";
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
  if (!round || round.phase !== "bidding") {
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

  const result = await placeBidAtomic({
    roundId: round.id,
    bidderId: params.bidderId,
    amountCents: params.amountCents,
    depositCents,
    depositRef,
  });

  if (!result.ok) {
    await provider.refund(depositRef);
    return { ok: false, reason: result.reason };
  }

  return { ok: true, bidId: result.bid.id, depositCents };
}
