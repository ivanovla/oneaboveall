import { and, asc, desc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { db } from "../db/client";
import { bids, rounds } from "../db/schema";
import { installChampion } from "./installChampion";

// Closes a round and, if settlement (settlement.ts, run by the scheduler at
// the daily close) collected a winner, installs them as champion. Only a
// *captured* bid can be installed: an uncaptured hold is not money we have,
// so a round whose settlement never captured anything closes empty — the
// reigning champion stays — exactly like a round nobody bid in. Every other
// hold in the round was already released by settlement.
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

  // The placedAt bound pins the winner to the bidding window: a bid placed
  // after the window closed can never win the snapshot, even if it somehow
  // slipped past the late-webhook guard.
  const [leader] = await db
    .select()
    .from(bids)
    .where(
      and(
        eq(bids.roundId, roundId),
        isNotNull(bids.capturedAt),
        isNull(bids.refundedAt),
        lte(bids.placedAt, snapshotAt),
      ),
    )
    .orderBy(desc(bids.amountCents), asc(bids.placedAt))
    .limit(1);
  if (!leader) {
    return { outcome: "empty-closed" };
  }

  await installChampion(leader.bidderId, leader.amountCents, executedAt, onInstalled);
  return { outcome: "installed" };
}
