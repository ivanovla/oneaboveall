import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { bids } from "../db/schema";
import { getQueueLeader, type Bid } from "../db/repository";
import type { PaymentProvider } from "../payments/PaymentProvider";
import { noopNotifier, notifySafely, type Notifier } from "../notifications/Notifier";
import { getHeldBids, releaseBid } from "./holds";

export type SettlementDeps = { provider: PaymentProvider; notifier?: Notifier };

// Collects the round's winning hold at the daily close — the moment bidding
// stops — rather than after the champion-processing gap: the art for the
// new champion is only worth preparing once the money is actually in, and
// the sooner the losing holds are dropped the better.
//
//   1. The winner is the top still-held bid placed at or before the close.
//      If it's already captured (an earlier tick settled this round), the
//      round is settled.
//   2. Otherwise capture it. A definitive failure (declined, hold expired)
//      releases that bid, records the failure, and moves on to the next one
//      — normally the runner-up recordBid kept held for exactly this. A
//      transient failure throws out of here with nothing changed, and the
//      scheduler's next tick retries the same bid.
//   3. Once one is captured, every other hold in the round is released.
//
// Safe to call on every tick through the processing gap (it is): an
// already-settled round costs a couple of reads, captures nothing and
// notifies no one. `won` is sent only by the call whose update actually
// moved the bid to captured, so the winner hears about it exactly once.
export async function settleRound(
  roundId: string,
  closeAt: Date,
  deps: SettlementDeps,
  now: Date,
): Promise<{ outcome: "captured"; bid: Bid } | { outcome: "nothing-captured" }> {
  const { provider, notifier = noopNotifier } = deps;

  let winner: Bid | null = null;
  let newlyCaptured = false;

  // A captured, unreleased bid is the round's winner, full stop — checked
  // before looking at the leader so that a bid committed in the instant
  // around the close, after this round was already settled, can never get
  // captured as a second winner (it's released below instead).
  const [alreadyCaptured] = await db
    .select()
    .from(bids)
    .where(and(eq(bids.roundId, roundId), isNotNull(bids.capturedAt), isNull(bids.refundedAt)))
    .limit(1);
  winner = alreadyCaptured ?? null;

  while (!winner) {
    const leader = await getQueueLeader(roundId, closeAt);
    if (!leader) break;

    // Throws on a transient error — deliberately uncaught: nothing has been
    // written for this bid yet, so the next tick simply tries it again.
    const result = await provider.capture(leader.paymentRef);
    if (result.ok) {
      const updated = await db
        .update(bids)
        .set({ capturedAt: now })
        .where(and(eq(bids.id, leader.id), isNull(bids.capturedAt)))
        .returning();
      newlyCaptured = updated.length > 0;
      winner = updated[0] ?? leader;
      break;
    }

    console.warn(`settlement: capture of bid ${leader.id} (${leader.paymentRef}) failed definitively: ${result.reason}`);
    // Drop whatever is left of the hold (idempotent — usually it's already
    // gone: declined, expired or cancelled), then take the bid out of the
    // running so the loop's next pass picks the runner-up. Release first,
    // mark second, same crash-safety ordering as releaseBid.
    await provider.release(leader.paymentRef);
    await db
      .update(bids)
      .set({ refundedAt: now, captureFailedAt: now })
      .where(and(eq(bids.id, leader.id), isNull(bids.refundedAt), isNull(bids.capturedAt)));
  }

  // Whatever is still held besides the winner is released: the runner-up
  // once the leader was collected, any hold a failed fallback chain left
  // behind, and any bid that (only possible from before late webhooks were
  // rejected) sits after the close. With no winner, that's every hold.
  //
  // Once a winner is captured, one release failing must not hold the round
  // hostage: a release that keeps throwing (say, the refund of a disputed
  // legacy charge Stripe won't touch) would otherwise make settleRound throw
  // on every tick, and the scheduler would never get past it to install the
  // champion. So with a winner, each failure is logged and the sweep moves
  // on to the next hold; every tick through the processing gap re-runs this
  // sweep, which retries whatever is still held. (A hold that is still stuck
  // once the round is installed lapses on its own when the authorization
  // expires — it was never captured.) Without a winner there is nothing to
  // protect, and a failure still throws so the next tick retries before the
  // round empty-closes.
  //
  // The "won" notification still sits in a finally: if anything else in the
  // sweep throws (a DB error), the next tick finds the winner already
  // captured (so newlyCaptured stays false there) and would otherwise never
  // send it.
  const won = winner;
  try {
    for (const bid of await getHeldBids(roundId)) {
      if (bid.id === won?.id) continue;
      if (!won) {
        await releaseBid(bid.id, provider, now);
        continue;
      }
      try {
        await releaseBid(bid.id, provider, now);
      } catch (err) {
        console.error(`settlement: releasing bid ${bid.id} (${bid.paymentRef}) failed; retrying on the next tick`, err);
      }
    }
  } finally {
    if (won && newlyCaptured) {
      await notifySafely("won", () => notifier.won({ bidderId: won.bidderId, amountCents: won.amountCents }));
    }
  }

  return won ? { outcome: "captured", bid: won } : { outcome: "nothing-captured" };
}
