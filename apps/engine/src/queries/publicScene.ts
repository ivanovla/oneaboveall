import { desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { bids, reigns, users } from "../db/schema";
import { getCurrentReign, getLatestRound, getQueueLeader } from "../db/repository";
import { nextDailyCloseAt } from "../domain/dailyClose";

// `reigns.occupantId` is a signed-in user's `users.id` — that was deliberate
// (the engine's bidderId and a user's id are the same value, so no extra
// mapping table was needed). But `occupant_id` is a plain `text` column while
// `users.id` is `uuid`, and Postgres has no implicit `text = uuid` operator:
// the join needs an explicit cast.
//
// The cast deliberately goes uuid -> text, not text -> uuid. `occupant_id` is
// not guaranteed to be a UUID at all — the bootstrap champion and every
// fixture in the test suite use human-typed ids like "champ" or "alice", and
// `'alice'::uuid` raises `invalid input syntax for type uuid`, which would
// fail the whole /scene request rather than simply not matching a user.
// `users.id::text` always succeeds and simply finds no match for a non-UUID
// occupant, which the LEFT JOIN then renders as a null name.
const occupantIsUser = sql`${users.id}::text = ${reigns.occupantId}`;

/**
 * The name to render publicly for an occupant.
 *
 * Falls back to the raw occupant id — the behavior this site had before OAuth
 * sign-in existed — whenever no usable name is available. Two real cases reach
 * that fallback:
 *
 *  - The occupant isn't a `users` row at all (the bootstrap champion, seeded
 *    fixtures), so the LEFT JOIN yields `null`.
 *  - The occupant is a real user whose `name` is empty. `users.name` is NOT
 *    NULL, but that only guarantees a string, not a non-empty one: Apple sends
 *    the display name exactly once, in the unsigned "user" form blob on the
 *    very first authorization, and `authApple.ts` stores `""` when that blob is
 *    absent or unparseable. So an empty name is genuinely reachable and must
 *    not render as a blank champion banner.
 */
function displayName(occupantId: string, name: string | null): string {
  return name && name.trim() !== "" ? name : occupantId;
}

// Same cast reasoning as occupantIsUser above, for bids.bidder_id (also
// plain text, also a users.id in practice, also arbitrary strings in tests).
const bidderIsUser = sql`${users.id}::text = ${bids.bidderId}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stricter sibling of `displayName` for /current-round — the busiest,
 * publicly cached route, also polled by the OBS overlay and therefore shown
 * on streams. `displayName`'s raw-id fallback is fine for a hand-typed
 * bootstrap id like "champ", but for a real user with an empty name it would
 * put their `users.id` on screen, and a bidder's id has never been public
 * before (it's what /rounds/:id/me and the admin API key on). So a
 * UUID-shaped id is never echoed: it becomes "Anonymous" instead.
 */
function publicName(id: string, name: string | null): string {
  if (name && name.trim() !== "") return name;
  return UUID_RE.test(id) ? "Anonymous" : id;
}

export async function getScene(_now: Date) {
  const [champion] = await db
    .select({
      occupantId: reigns.occupantId,
      occupantName: users.name,
      priceCents: reigns.priceCents,
      startedAt: reigns.startedAt,
      socialUrl: users.socialUrl,
      sponsored: users.sponsored,
    })
    .from(reigns)
    .leftJoin(users, occupantIsUser)
    .where(isNull(reigns.endedAt))
    .limit(1);

  const retinueRows = await db
    .select({
      occupantId: reigns.occupantId,
      occupantName: users.name,
      priceCents: reigns.priceCents,
      startedAt: reigns.startedAt,
      endedAt: reigns.endedAt,
      socialUrl: users.socialUrl,
      sponsored: users.sponsored,
    })
    .from(reigns)
    .leftJoin(users, occupantIsUser)
    .where(isNotNull(reigns.endedAt))
    .orderBy(desc(reigns.endedAt))
    .limit(8);

  return {
    champion: champion
      ? {
          occupantId: champion.occupantId,
          occupantName: displayName(champion.occupantId, champion.occupantName),
          priceCents: champion.priceCents,
          since: champion.startedAt,
          socialUrl: champion.socialUrl,
          // LEFT JOIN: a non-user occupant has no row, so null → false.
          sponsored: champion.sponsored === true,
        }
      : null,
    retinue: retinueRows.map((r) => ({
      occupantId: r.occupantId,
      occupantName: displayName(r.occupantId, r.occupantName),
      priceCents: r.priceCents,
      startedAt: r.startedAt,
      endedAt: r.endedAt!,
      socialUrl: r.socialUrl,
      sponsored: r.sponsored === true,
    })),
  };
}

export async function getLeaderboard() {
  const ended = await db
    .select({
      occupantId: reigns.occupantId,
      occupantName: users.name,
      priceCents: reigns.priceCents,
      startedAt: reigns.startedAt,
      endedAt: reigns.endedAt,
      sponsored: users.sponsored,
    })
    .from(reigns)
    .leftJoin(users, occupantIsUser)
    .where(isNotNull(reigns.endedAt));

  const byOccupant = new Map<
    string,
    { occupantName: string; sponsored: boolean; rounds: number; totalSpentCents: number; totalDurationMs: number }
  >();
  for (const r of ended) {
    const entry =
      byOccupant.get(r.occupantId) ??
      {
        occupantName: displayName(r.occupantId, r.occupantName),
        sponsored: r.sponsored === true,
        rounds: 0,
        totalSpentCents: 0,
        totalDurationMs: 0,
      };
    entry.rounds += 1;
    entry.totalSpentCents += r.priceCents;
    entry.totalDurationMs += r.endedAt!.getTime() - r.startedAt.getTime();
    byOccupant.set(r.occupantId, entry);
  }

  return [...byOccupant.entries()]
    .map(([occupantId, stats]) => ({ occupantId, ...stats }))
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs);
}

export type PublicPerson = { name: string; sponsored: boolean };
export type PublicRecentBid = { name: string; amountCents: number; placedAt: Date };

// How many of the round's latest bids /current-round lists — the homepage
// and OBS overlay's "live feed". Small on purpose: this payload is polled
// by every open tab.
const RECENT_BIDS_LIMIT = 5;

async function getUserPublicPerson(id: string): Promise<PublicPerson> {
  // Compared as text (see occupantIsUser) so a non-UUID id simply finds no
  // user instead of raising a cast error.
  const [row] = await db
    .select({ name: users.name, sponsored: users.sponsored })
    .from(users)
    .where(sql`${users.id}::text = ${id}`)
    .limit(1);
  return { name: publicName(id, row?.name ?? null), sponsored: row?.sponsored === true };
}

/**
 * Everything the homepage chrome and the OBS overlay poll for — and,
 * because /current-round is cached in-process and served `public` to any
 * CDN, deliberately identical for every caller: nothing here may depend on
 * who is asking, and nothing here may identify a bidder beyond the display
 * name they chose to show publicly (no user ids, no emails).
 *
 * `leader` is the top *unreleased* bid's bidder (the same bid
 * currentLeaderCents comes from), null when nobody has bid this round.
 * `recentBids` is the round's last few bids newest first, released ones
 * included — being outbid is the drama — so it can name someone who is no
 * longer leading.
 */
export async function getCurrentRoundInfo(_now: Date): Promise<{
  roundId: string;
  phase: "bidding" | "closed";
  currentLeaderCents: number;
  biddingClosesAt: Date;
  leader: PublicPerson | null;
  champion: PublicPerson | null;
  recentBids: PublicRecentBid[];
} | null> {
  const reign = await getCurrentReign();
  if (!reign) return null;

  const round = await getLatestRound(reign.id);
  if (!round) return null;

  const topBid = await getQueueLeader(round.id);

  const recentRows = await db
    .select({ bidderId: bids.bidderId, name: users.name, amountCents: bids.amountCents, placedAt: bids.placedAt })
    .from(bids)
    .leftJoin(users, bidderIsUser)
    .where(eq(bids.roundId, round.id))
    .orderBy(desc(bids.placedAt))
    .limit(RECENT_BIDS_LIMIT);

  return {
    roundId: round.id,
    phase: round.phase,
    currentLeaderCents: topBid ? topBid.amountCents : reign.priceCents,
    biddingClosesAt: nextDailyCloseAt(round.startsAt),
    leader: topBid ? await getUserPublicPerson(topBid.bidderId) : null,
    champion: await getUserPublicPerson(reign.occupantId),
    // A bid always has a bidder, but "Anonymous" (not the id) for one whose
    // name is empty — same rule as publicName, applied unconditionally
    // since a bidder id is never meant to be public.
    recentBids: recentRows.map((r) => ({
      name: r.name && r.name.trim() !== "" ? r.name : "Anonymous",
      amountCents: r.amountCents,
      placedAt: r.placedAt,
    })),
  };
}
