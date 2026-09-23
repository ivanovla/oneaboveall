import { desc, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { reigns, users } from "../db/schema";
import { getCurrentReign, getLatestRound, getQueueLeader } from "../db/repository";
import { calculateDeposit } from "../domain/deposit";
import { BIDDING_PHASE_MS } from "../domain/config";

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

export async function getScene(_now: Date) {
  const [champion] = await db
    .select({
      occupantId: reigns.occupantId,
      occupantName: users.name,
      priceCents: reigns.priceCents,
      startedAt: reigns.startedAt,
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
        }
      : null,
    retinue: retinueRows.map((r) => ({
      occupantId: r.occupantId,
      occupantName: displayName(r.occupantId, r.occupantName),
      priceCents: r.priceCents,
      startedAt: r.startedAt,
      endedAt: r.endedAt!,
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
    })
    .from(reigns)
    .leftJoin(users, occupantIsUser)
    .where(isNotNull(reigns.endedAt));

  const byOccupant = new Map<
    string,
    { occupantName: string; rounds: number; totalSpentCents: number; totalDurationMs: number }
  >();
  for (const r of ended) {
    const entry =
      byOccupant.get(r.occupantId) ??
      { occupantName: displayName(r.occupantId, r.occupantName), rounds: 0, totalSpentCents: 0, totalDurationMs: 0 };
    entry.rounds += 1;
    entry.totalSpentCents += r.priceCents;
    entry.totalDurationMs += r.endedAt!.getTime() - r.startedAt.getTime();
    byOccupant.set(r.occupantId, entry);
  }

  return [...byOccupant.entries()]
    .map(([occupantId, stats]) => ({ occupantId, ...stats }))
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs);
}

export async function getCurrentRoundInfo(_now: Date): Promise<{
  roundId: string;
  phase: "bidding" | "resolving" | "payment" | "closed";
  currentLeaderCents: number;
  depositCents: number;
  biddingClosesAt: Date;
} | null> {
  const reign = await getCurrentReign();
  if (!reign) return null;

  const round = await getLatestRound(reign.id);
  if (!round) return null;

  const topBid = await getQueueLeader(round.id);

  return {
    roundId: round.id,
    phase: round.phase,
    currentLeaderCents: topBid ? topBid.amountCents : reign.priceCents,
    depositCents: calculateDeposit(reign.priceCents),
    biddingClosesAt: new Date(round.startsAt.getTime() + BIDDING_PHASE_MS),
  };
}
