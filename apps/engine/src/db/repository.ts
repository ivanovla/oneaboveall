import { and, desc, asc, eq, lte, isNull, sql } from "drizzle-orm";
import { db } from "./client";
import { reigns, rounds, bids, pageViews } from "./schema";
import { validateBidAmount } from "../domain/bidValidation";

export type Reign = typeof reigns.$inferSelect;
export type Round = typeof rounds.$inferSelect;
export type Bid = typeof bids.$inferSelect;

export async function getCurrentReign(): Promise<Reign | null> {
  const [reign] = await db.select().from(reigns).where(isNull(reigns.endedAt)).limit(1);
  return reign ?? null;
}

export async function getLatestRound(reignId: string): Promise<Round | null> {
  const [round] = await db
    .select()
    .from(rounds)
    .where(eq(rounds.reignId, reignId))
    .orderBy(desc(rounds.startsAt))
    .limit(1);
  return round ?? null;
}

export async function getQueueLeader(roundId: string, asOf?: Date): Promise<Bid | null> {
  // `asOf` (optional, no time filter by default) restricts the queue to bids
  // placed at or before that instant. The bidding-phase snapshot passes the
  // window's close time so that a bid which somehow slipped past the window
  // guard can never win the snapshot. A refunded (outbid) bid is never a
  // candidate leader — only the one still-unrefunded bid in a round (if any)
  // can be.
  const where = asOf
    ? and(eq(bids.roundId, roundId), isNull(bids.refundedAt), lte(bids.placedAt, asOf))
    : and(eq(bids.roundId, roundId), isNull(bids.refundedAt));
  const [top] = await db
    .select()
    .from(bids)
    .where(where)
    .orderBy(desc(bids.amountCents), asc(bids.placedAt))
    .limit(1);
  return top ?? null;
}

// This bidder's own highest bid in the round, independent of who's
// currently leading (and regardless of whether it was later outbid and
// refunded). Used to distinguish "never bid" from "bid but got outbid".
export async function getBidderTopBid(roundId: string, bidderId: string): Promise<Bid | null> {
  const [top] = await db
    .select()
    .from(bids)
    .where(and(eq(bids.roundId, roundId), eq(bids.bidderId, bidderId)))
    .orderBy(desc(bids.amountCents), asc(bids.placedAt))
    .limit(1);
  return top ?? null;
}

export type BidderHistoryEntry = {
  roundId: string;
  bids: { amountCents: number; placedAt: Date; status: "active" | "won" | "refunded" }[];
};

// Every round this bidder ever placed a bid in, most recent bid first, each
// with all of their own bids in that round (not the round's overall leader —
// this is a personal activity history, not a leaderboard). A bid's own
// status tells the outcome directly: "refunded" means a later bid (by
// someone else) outbid it and the money already came back; "active" means
// it's still the unrefunded leader of a round still in progress; "won" means
// it's still unrefunded and the round has closed — i.e. it's the winning bid.
//
// One query per round rather than a single joined query — deliberately: a
// bidder's total round count is small (rounds are ~daily), so the join's
// added complexity isn't worth it for what stays a handful of round-trips.
export async function getBidderHistory(bidderId: string): Promise<BidderHistoryEntry[]> {
  const ownBids = await db
    .select()
    .from(bids)
    .where(eq(bids.bidderId, bidderId))
    .orderBy(desc(bids.placedAt));

  const roundIds = [...new Set(ownBids.map((b) => b.roundId))];
  const roundPhaseById = new Map<string, Round["phase"]>();
  for (const roundId of roundIds) {
    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId)).limit(1);
    if (round) roundPhaseById.set(roundId, round.phase);
  }

  const entriesByRound = new Map<string, BidderHistoryEntry>();
  for (const bid of ownBids) {
    const status: "active" | "won" | "refunded" = bid.refundedAt
      ? "refunded"
      : roundPhaseById.get(bid.roundId) === "closed"
        ? "won"
        : "active";
    const entry = entriesByRound.get(bid.roundId) ?? { roundId: bid.roundId, bids: [] };
    entry.bids.push({ amountCents: bid.amountCents, placedAt: bid.placedAt, status });
    entriesByRound.set(bid.roundId, entry);
  }

  // Preserve "most recent round first" ordering — entriesByRound iteration
  // order follows first-insertion, and ownBids is already newest-bid-first.
  return [...entriesByRound.values()];
}

const SERIALIZATION_FAILURE = "40001";
const UNIQUE_VIOLATION = "23505";

// The authoritative post-payment record of a bid: this bidder's Stripe charge
// for the full amount already succeeded (that's why this function is being
// called at all — from the payment_intent.succeeded webhook), so what's left
// is purely bookkeeping: verify the round will still accept it, verify it
// still beats the current leader, and if a previous leader is displaced,
// report who so the caller can refund them (refunding is an external side
// effect the caller performs — this function's own job is limited to the DB
// transaction).
export async function recordBidAtomic(params: {
  roundId: string;
  bidderId: string;
  amountCents: number;
  paymentRef: string;
  placedAt?: Date;
  onRetry?: () => void;
}): Promise<
  | { outcome: "recorded"; bid: Bid; displacedBid: Bid | null }
  | { outcome: "already-recorded" }
  | { outcome: "rejected"; reason: string }
> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await db.transaction(
        async (tx) => {
          const [existing] = await tx.select().from(bids).where(eq(bids.paymentRef, params.paymentRef)).limit(1);
          if (existing) return { outcome: "already-recorded" as const };

          const [round] = await tx.select().from(rounds).where(eq(rounds.id, params.roundId)).limit(1);
          if (!round) return { outcome: "rejected" as const, reason: "Round not found." };
          if (round.phase !== "bidding") return { outcome: "rejected" as const, reason: "Round is not accepting bids." };

          const [reign] = await tx.select().from(reigns).where(eq(reigns.id, round.reignId)).limit(1);
          if (!reign) return { outcome: "rejected" as const, reason: "Reign not found." };

          const [topBid] = await tx
            .select()
            .from(bids)
            .where(and(eq(bids.roundId, params.roundId), isNull(bids.refundedAt)))
            .orderBy(desc(bids.amountCents), asc(bids.placedAt))
            .limit(1);

          if (topBid && topBid.bidderId === params.bidderId) {
            return { outcome: "rejected" as const, reason: "You are already the current leader — wait to be outbid before raising your own bid." };
          }

          const currentLeaderCents = topBid ? topBid.amountCents : reign.priceCents;
          const validation = validateBidAmount(params.amountCents, currentLeaderCents);
          if (!validation.valid) return { outcome: "rejected" as const, reason: validation.reason };

          let inserted: Bid;
          try {
            const rows = await tx
              .insert(bids)
              .values({
                roundId: params.roundId,
                bidderId: params.bidderId,
                amountCents: params.amountCents,
                paymentRef: params.paymentRef,
                ...(params.placedAt ? { placedAt: params.placedAt } : {}),
              })
              .returning();
            inserted = rows[0];
          } catch (err: any) {
            if (err?.code === UNIQUE_VIOLATION) return { outcome: "already-recorded" as const };
            throw err;
          }

          return { outcome: "recorded" as const, bid: inserted, displacedBid: topBid ?? null };
        },
        { isolationLevel: "serializable" },
      );
    } catch (err: any) {
      if (err?.code === SERIALIZATION_FAILURE && attempt < maxAttempts) {
        params.onRetry?.();
        continue;
      }
      throw err;
    }
  }
  throw new Error("recordBidAtomic: exceeded retry attempts under serialization conflict");
}

// Atomically creates the single counter row (id 1) on its very first call
// and increments it on every one after — one round-trip, no race between
// two concurrent first requests both trying to insert it.
export async function incrementPageViews(): Promise<number> {
  const [row] = await db
    .insert(pageViews)
    .values({ id: 1, count: 1 })
    .onConflictDoUpdate({ target: pageViews.id, set: { count: sql`${pageViews.count} + 1` } })
    .returning();
  return row.count;
}
