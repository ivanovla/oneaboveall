import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { bids } from "../db/schema";
import { recordBidAtomic } from "../db/repository";
import type { PaymentProvider } from "../payments/PaymentProvider";
import { noopNotifier, notifySafely, type Notifier } from "../notifications/Notifier";
import { releaseSupersededHolds } from "./holds";

// Called from the Stripe webhook once a bid's PaymentIntent holds the full
// amount (payment_intent.amount_capturable_updated — or .succeeded, for one
// created before holds existed). Bookkeeping happens atomically in
// recordBidAtomic; this wraps it with the side effects that have to happen
// outside any DB transaction:
//   - releasing holds the round no longer needs (only the top bid and the
//     runner-up stay held — see holds.ts),
//   - releasing the bid's own hold if it turned out not to qualify after all
//     (the hold already exists by the time we get here, so a rejection means
//     it has to be dropped, not that nothing happened),
//   - telling the displaced leader they've been outbid.
//
// `placedAt` is when the bid counts as placed — what the daily-close check
// and the leader tie-break judge it by. The webhook passes the moment Stripe
// says the hold was secured (the signed event.created), not the moment the
// webhook happened to be processed: a hold authorized at 15:59:58 whose
// webhook lands at 16:00:03 was placed in time. `now` is the processing
// time, used to stamp the releases this call makes. placedAt defaults to now.
export async function recordBid(
  params: { roundId: string; bidderId: string; amountCents: number; paymentRef: string; now: Date; placedAt?: Date },
  provider: PaymentProvider,
  notifier: Notifier = noopNotifier,
): Promise<{ outcome: "recorded" | "already-recorded" | "released" }> {
  const result = await recordBidAtomic({
    roundId: params.roundId,
    bidderId: params.bidderId,
    amountCents: params.amountCents,
    paymentRef: params.paymentRef,
    placedAt: params.placedAt ?? params.now,
  });

  if (result.outcome === "already-recorded") {
    // A redelivery (or the second of the two events a hold produces — see
    // stripeWebhook.ts). Nothing to record or notify, but re-running the
    // sweep is what finishes releases a previous attempt crashed or failed
    // partway through: that attempt's failure is exactly what made Stripe
    // redeliver.
    await releaseSupersededHolds(params.roundId, provider, params.now);
    return { outcome: "already-recorded" };
  }

  if (result.outcome === "rejected") {
    // The hold already exists (that's why we're here), but by the time this
    // webhook landed the bid no longer qualifies (outbid in a race, the
    // round closed, or the bidder was already leading). Drop it rather than
    // stranding a hold with no bid to show for it.
    //
    // Unless the bid *was* recorded after all: two concurrent deliveries of
    // the same webhook each run their own transaction, and the one whose
    // snapshot predates the other's commit never sees the row — it can come
    // back "rejected" (say it landed a moment later and saw the close) while
    // the other delivery recorded the bid. Releasing here would cancel the
    // hold under a live, recorded bid. So check, outside that snapshot, for
    // a row with this paymentRef first; if there is one, this delivery is
    // just a duplicate.
    const [recorded] = await db.select({ id: bids.id }).from(bids).where(eq(bids.paymentRef, params.paymentRef)).limit(1);
    if (recorded) return { outcome: "already-recorded" };
    await provider.release(params.paymentRef);
    return { outcome: "released" };
  }

  // result.outcome === "recorded". Money before messaging: the sweep runs
  // first so a slow email provider never delays dropping holds, but the
  // notification sits in a finally — a release failing — which
  // makes the webhook 500 and Stripe redeliver, where the redelivery takes
  // the "already-recorded" path above and never notifies — must not cost
  // the displaced leader their only notification.
  try {
    await releaseSupersededHolds(params.roundId, provider, params.now);
  } finally {
    const displaced = result.displacedBid;
    // recordBidAtomic already rejects a bid by the current leader, so a
    // displaced bid is always someone else's — checked anyway, because
    // telling someone they were outbid by themselves would be absurd.
    if (displaced && displaced.bidderId !== params.bidderId) {
      await notifySafely("outbid", () =>
        notifier.outbid({ bidderId: displaced.bidderId, amountCents: params.amountCents }),
      );
    }
  }

  return { outcome: "recorded" };
}
