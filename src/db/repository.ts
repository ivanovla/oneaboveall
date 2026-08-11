import { and, desc, asc, eq, gt, isNull } from "drizzle-orm";
import { db } from "./client";
import { reigns, rounds, bids, bans } from "./schema";
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

export async function getQueueLeader(roundId: string): Promise<Bid | null> {
  const [top] = await db
    .select()
    .from(bids)
    .where(eq(bids.roundId, roundId))
    .orderBy(desc(bids.amountCents), asc(bids.placedAt))
    .limit(1);
  return top ?? null;
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
  depositCents: number;
  depositRef: string;
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
              depositCents: params.depositCents,
              depositRef: params.depositRef,
              depositStatus: "held",
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
