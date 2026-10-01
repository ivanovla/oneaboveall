import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { bids, refVisits, users } from "../db/schema";
import { getCurrentReign, getLatestRound } from "../db/repository";
import { getHeldBids } from "../engine/holds";
import { nextDailyCloseAt } from "../domain/dailyClose";

// Operator-only queries behind apps/api's /admin routes (bearer-token
// gated). Unlike engine/queries/publicScene.ts, these deliberately return
// emails and user ids — they exist so the operator can contact a winner,
// fetch their photo and moderate them — and must never be wired to a
// public route.

export type RefStats = {
  ref: string;
  visits: number;
  signups: number;
  bidders: number;
  winners: number;
  revenueCents: number;
};

/**
 * Funnel per streamer ref: visits (ref_visits) → sign-ups (users whose
 * first-touch ref is this one) → distinct bidders → distinct winners
 * (bids actually captured) → captured revenue. Totals cover everyone,
 * attributed or not, so "how much of the business is attributable at all"
 * is one subtraction away.
 *
 * Aggregated in JS over three small grouped queries rather than one big
 * SQL statement: the user and bidder counts are tiny at this scale, and the
 * text/uuid join caveat (bids.bidder_id is text — see publicScene.ts) is
 * easier to get right as a Map lookup than as a cast inside a GROUP BY.
 */
export async function getAdminStats(): Promise<{ refs: RefStats[]; totals: Omit<RefStats, "ref"> }> {
  const visitRows = await db.select().from(refVisits);
  const userRows = await db.select({ id: users.id, ref: users.ref }).from(users);
  const bidderRows = await db
    .select({
      bidderId: bids.bidderId,
      won: sql<boolean>`bool_or(${bids.capturedAt} is not null)`,
      revenueCents: sql<string>`coalesce(sum(${bids.amountCents}) filter (where ${bids.capturedAt} is not null), 0)`,
    })
    .from(bids)
    .groupBy(bids.bidderId);

  const refByUser = new Map(userRows.map((u) => [u.id, u.ref]));
  const byRef = new Map<string, RefStats>();
  const entry = (ref: string): RefStats => {
    let stats = byRef.get(ref);
    if (!stats) {
      stats = { ref, visits: 0, signups: 0, bidders: 0, winners: 0, revenueCents: 0 };
      byRef.set(ref, stats);
    }
    return stats;
  };

  for (const v of visitRows) entry(v.ref).visits += v.count;
  for (const u of userRows) if (u.ref) entry(u.ref).signups += 1;

  const totals = {
    visits: visitRows.reduce((sum, v) => sum + v.count, 0),
    signups: userRows.length,
    bidders: 0,
    winners: 0,
    revenueCents: 0,
  };
  for (const b of bidderRows) {
    // sum() comes back from node-postgres as a string (bigint); a single
    // seat sale is far below 2^53, so Number() is exact.
    const revenueCents = Number(b.revenueCents);
    totals.bidders += 1;
    if (b.won) totals.winners += 1;
    totals.revenueCents += revenueCents;

    const ref = refByUser.get(b.bidderId);
    if (!ref) continue;
    const stats = entry(ref);
    stats.bidders += 1;
    if (b.won) stats.winners += 1;
    stats.revenueCents += revenueCents;
  }

  const refs = [...byRef.values()].sort((a, b) => b.revenueCents - a.revenueCents || b.visits - a.visits);
  return { refs, totals };
}

export type AdminUserDetails = {
  userId: string;
  name: string | null;
  email: string | null;
  hasPhoto: boolean;
  socialUrl: string | null;
  characterRequest: string | null;
  sponsored: boolean;
};

export type AdminBid = AdminUserDetails & {
  bidId: string;
  amountCents: number;
  placedAt: Date;
  captured: boolean;
};

async function getUserDetails(id: string): Promise<AdminUserDetails> {
  const [row] = await db
    .select()
    .from(users)
    .where(sql`${users.id}::text = ${id}`)
    .limit(1);
  return {
    userId: id,
    name: row?.name ?? null,
    email: row?.email ?? null,
    hasPhoto: !!row?.photoPath,
    socialUrl: row?.socialUrl ?? null,
    characterRequest: row?.characterRequest ?? null,
    sponsored: row?.sponsored === true,
  };
}

/**
 * The live round as the operator needs it: who is leading, who the
 * fallback (runner-up) is — the same two holds engine/engine/holds.ts keeps
 * alive, picked the same way (top unreleased bid by amount then time; the
 * runner-up is the best unreleased bid by a *different* bidder) — plus the
 * reigning champion, whose photo is what the operator composes into the
 * scene art after a round closes and a new champion is installed.
 */
export async function getAdminRound() {
  const reign = await getCurrentReign();
  if (!reign) return null;
  const round = await getLatestRound(reign.id);

  const champion = { ...(await getUserDetails(reign.occupantId)), priceCents: reign.priceCents, since: reign.startedAt };
  if (!round) return { round: null, champion, leader: null, runnerUp: null };

  const held = await getHeldBids(round.id);
  const top = held[0] ?? null;
  const runner = top ? (held.find((b) => b.bidderId !== top.bidderId) ?? null) : null;

  const describe = async (bid: NonNullable<typeof top>): Promise<AdminBid> => ({
    ...(await getUserDetails(bid.bidderId)),
    bidId: bid.id,
    amountCents: bid.amountCents,
    placedAt: bid.placedAt,
    captured: bid.capturedAt !== null,
  });

  return {
    round: { id: round.id, phase: round.phase, startsAt: round.startsAt, biddingClosesAt: nextDailyCloseAt(round.startsAt) },
    champion,
    leader: top ? await describe(top) : null,
    runnerUp: runner ? await describe(runner) : null,
  };
}

