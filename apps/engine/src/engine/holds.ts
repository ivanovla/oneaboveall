import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { bids } from "../db/schema";
import type { Bid } from "../db/repository";
import type { PaymentProvider } from "../payments/PaymentProvider";

// Drops one bid's hold and marks it released. Release first, mark second,
// and re-check immediately before both: a crash between the two never
// leaves the database falsely claiming a hold was dropped (the next caller
// just releases again — PaymentProvider.release is idempotent), and two
// concurrent callers never both mark it. A captured bid is never released:
// that would refund the round's winner.
export async function releaseBid(bidId: string, provider: PaymentProvider, now: Date): Promise<void> {
  const [current] = await db.select().from(bids).where(eq(bids.id, bidId)).limit(1);
  if (!current || current.refundedAt !== null || current.capturedAt !== null) return;

  await provider.release(current.paymentRef);
  await db
    .update(bids)
    .set({ refundedAt: now })
    .where(and(eq(bids.id, bidId), isNull(bids.refundedAt), isNull(bids.capturedAt)));
}

// Every bid in the round that still holds money, best first — the same
// ordering the leader query uses (amount desc, earliest wins a tie).
export async function getHeldBids(roundId: string): Promise<Bid[]> {
  return db
    .select()
    .from(bids)
    .where(and(eq(bids.roundId, roundId), isNull(bids.refundedAt)))
    .orderBy(desc(bids.amountCents), asc(bids.placedAt));
}

// Keeps at most two holds alive in a round: the top bid, and the highest
// bid by a *different* bidder (the runner-up — the fallback settlement
// captures if collecting the top bid fails). Everything else is released,
// including a bidder's own older hold once they re-bid over someone else.
//
// Recomputed from the database every time rather than from "the bid just
// recorded": two webhooks finishing out of order then still converge on the
// same two survivors, and a redelivered webhook re-running this finishes
// whatever releases an earlier, crashed attempt left undone.
export async function releaseSupersededHolds(roundId: string, provider: PaymentProvider, now: Date): Promise<void> {
  const held = await getHeldBids(roundId);
  const top = held[0];
  if (!top) return;
  const runnerUp = held.find((bid) => bid.bidderId !== top.bidderId);

  for (const bid of held) {
    if (bid.id === top.id || bid.id === runnerUp?.id) continue;
    await releaseBid(bid.id, provider, now);
  }
}
