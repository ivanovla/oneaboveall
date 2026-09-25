import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { bids } from "../db/schema";
import { recordBidAtomic } from "../db/repository";
import type { PaymentProvider } from "../payments/PaymentProvider";

// Called from the Stripe webhook once a bid's full-amount PaymentIntent has
// actually succeeded. Bookkeeping happens atomically in recordBidAtomic;
// this wraps it with the one side effect that has to happen outside any DB
// transaction — refunding whichever bid this one just displaced, and handing
// back a bid that turned out not to qualify after all (the charge already
// succeeded by the time we get here, so a rejection here means the money has
// to go straight back, not that nothing happened).
export async function recordBid(
  params: { roundId: string; bidderId: string; amountCents: number; paymentRef: string; now: Date },
  provider: PaymentProvider,
): Promise<{ outcome: "recorded" | "already-recorded" | "refunded" }> {
  const result = await recordBidAtomic({
    roundId: params.roundId,
    bidderId: params.bidderId,
    amountCents: params.amountCents,
    paymentRef: params.paymentRef,
    placedAt: params.now,
  });

  if (result.outcome === "already-recorded") {
    return { outcome: "already-recorded" };
  }

  if (result.outcome === "rejected") {
    // The charge already succeeded (that's why we're here), but by the time
    // this webhook landed the bid no longer qualifies (outbid in a race, the
    // round closed, or the bidder was already leading). Give the money back
    // rather than stranding a charge with no bid to show for it.
    await provider.refund(params.paymentRef);
    return { outcome: "refunded" };
  }

  // result.outcome === "recorded". Refund the bid this one displaced, if
  // any — refund first, mark second, and re-check refundedAt is still null
  // immediately before updating, so a crash between the two never leaves the
  // database falsely claiming money was returned, and a concurrent duplicate
  // call never double-refunds the same PaymentIntent.
  if (result.displacedBid) {
    const [current] = await db.select().from(bids).where(eq(bids.id, result.displacedBid.id)).limit(1);
    if (current && current.refundedAt === null) {
      await provider.refund(current.paymentRef);
      await db
        .update(bids)
        .set({ refundedAt: params.now })
        .where(and(eq(bids.id, result.displacedBid.id), isNull(bids.refundedAt)));
    }
  }

  return { outcome: "recorded" };
}
