import { and, desc, asc, eq, gt, isNull } from "drizzle-orm";
import { db } from "./client";
import { reigns, rounds, bids, bans } from "./schema";

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
