import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { rounds } from "../db/schema";
import { getQueueLeader } from "../db/repository";
import { installChampion } from "./installChampion";

// Closes a round's bidding window and, if it had a leader, installs them as
// champion on the spot — the winner already paid the full amount when they
// placed their bid, so there is nothing left to charge or offer, and no one
// else is ever owed a refund at this point (every bid that wasn't the
// round's final leader was already refunded, synchronously, the moment it
// got outbid — see recordBid.ts).
export async function resolveBiddingPhaseSnapshot(
  roundId: string,
  // The instant the bidding window closed on the ideal schedule grid
  // (round.startsAt + BIDDING_PHASE_MS) — used to pin which bids are even
  // eligible to be the leader.
  snapshotAt: Date,
  onInstalled?: (occupantId: string) => void,
  // The instant this resolution is actually running. Defaults to snapshotAt
  // (an on-time tick); the scheduler passes the real clock so a late tick
  // installs the champion (and starts their next round) at the moment it
  // actually ran, not backdated to the ideal grid slot.
  executedAt: Date = snapshotAt,
): Promise<{ outcome: "empty-closed" } | { outcome: "installed" } | { outcome: "already-resolving" }> {
  // Claim-before-close: without this, two overlapping scheduler ticks (or two
  // worker instances) both seeing phase = "bidding" would both proceed, and
  // both try to install a champion for the same round.
  const claimed = await db
    .update(rounds)
    .set({ phase: "closed" })
    .where(and(eq(rounds.id, roundId), eq(rounds.phase, "bidding")))
    .returning();

  if (claimed.length === 0) {
    // Someone else already closed this round — that caller owns its fate.
    return { outcome: "already-resolving" };
  }

  // asOf pins the queue to the bidding window: a bid placed after the window
  // closed can never win the snapshot, even if it somehow slipped past the
  // route's window guard.
  const leader = await getQueueLeader(roundId, snapshotAt);
  if (!leader) {
    return { outcome: "empty-closed" };
  }

  await installChampion(leader.bidderId, leader.amountCents, executedAt, onInstalled);
  return { outcome: "installed" };
}
