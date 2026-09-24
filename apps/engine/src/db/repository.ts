import { and, desc, asc, eq, gt, lte, isNull } from "drizzle-orm";
import { db } from "./client";
import { reigns, rounds, bids, bans, roundParticipants } from "./schema";
import { validateBidAmount } from "../domain/bidValidation";

export type Reign = typeof reigns.$inferSelect;
export type Round = typeof rounds.$inferSelect;
export type Bid = typeof bids.$inferSelect;
export type RoundParticipant = typeof roundParticipants.$inferSelect;

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
  // window's close time so that a bid which somehow slipped past placeBid's
  // window guard can never win the snapshot.
  const where = asOf ? and(eq(bids.roundId, roundId), lte(bids.placedAt, asOf)) : eq(bids.roundId, roundId);
  const [top] = await db
    .select()
    .from(bids)
    .where(where)
    .orderBy(desc(bids.amountCents), asc(bids.placedAt))
    .limit(1);
  return top ?? null;
}

// This bidder's own highest bid in the round, independent of who's
// currently leading. Used to distinguish "never bid" from "bid but got
// outbid" — getQueueLeader alone can't tell those apart.
export async function getBidderTopBid(roundId: string, bidderId: string): Promise<Bid | null> {
  const [top] = await db
    .select()
    .from(bids)
    .where(and(eq(bids.roundId, roundId), eq(bids.bidderId, bidderId)))
    .orderBy(desc(bids.amountCents), asc(bids.placedAt))
    .limit(1);
  return top ?? null;
}

export async function getRoundParticipant(roundId: string, bidderId: string): Promise<RoundParticipant | null> {
  const [row] = await db
    .select()
    .from(roundParticipants)
    .where(and(eq(roundParticipants.roundId, roundId), eq(roundParticipants.bidderId, bidderId)))
    .limit(1);
  return row ?? null;
}

export async function isBanned(bidderId: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select()
    .from(bans)
    .where(and(eq(bans.bidderId, bidderId), gt(bans.bannedUntil, now)))
    .limit(1);
  return !!row;
}

const SERIALIZATION_FAILURE = "40001";

export async function placeBidAtomic(params: {
  roundId: string;
  bidderId: string;
  amountCents: number;
  // When omitted the column's DEFAULT now() (the database clock) is used.
  // placeBid passes its own `now` so that a bid's placedAt agrees with the
  // instant the bidding-window guard was evaluated against — the snapshot's
  // `asOf` filter compares the two.
  placedAt?: Date;
  onRetry?: () => void;
}): Promise<{ ok: true; bid: Bid } | { ok: false; reason: string }> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await db.transaction(
        async (tx) => {
          const [round] = await tx.select().from(rounds).where(eq(rounds.id, params.roundId)).limit(1);
          if (!round) return { ok: false, reason: "Round not found." };
          if (round.phase !== "bidding") return { ok: false, reason: "Round is not accepting bids." };

          const [reign] = await tx.select().from(reigns).where(eq(reigns.id, round.reignId)).limit(1);
          if (!reign) return { ok: false, reason: "Reign not found." };

          // Authoritative check: fast-path duplicate of this lives in placeBid.ts,
          // but this is the one that actually guards correctness inside the
          // transaction, same rationale as the amount/phase checks above it.
          const [participant] = await tx
            .select()
            .from(roundParticipants)
            .where(and(eq(roundParticipants.roundId, params.roundId), eq(roundParticipants.bidderId, params.bidderId)))
            .limit(1);
          if (!participant || participant.depositStatus !== "held") {
            return { ok: false, reason: "Join this round (pay the deposit) before placing a bid." };
          }

          const [topBid] = await tx
            .select()
            .from(bids)
            .where(eq(bids.roundId, params.roundId))
            .orderBy(desc(bids.amountCents), asc(bids.placedAt))
            .limit(1);

          const currentLeaderCents = topBid ? topBid.amountCents : reign.priceCents;
          const validation = validateBidAmount(params.amountCents, currentLeaderCents);
          if (!validation.valid) return { ok: false, reason: validation.reason };

          const [inserted] = await tx
            .insert(bids)
            .values({
              roundId: params.roundId,
              bidderId: params.bidderId,
              amountCents: params.amountCents,
              ...(params.placedAt ? { placedAt: params.placedAt } : {}),
            })
            .returning();

          return { ok: true, bid: inserted };
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
  throw new Error("placeBidAtomic: exceeded retry attempts under serialization conflict");
}
