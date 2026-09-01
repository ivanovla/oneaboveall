import { desc, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { reigns } from "../db/schema";

export async function getScene(_now: Date) {
  const [champion] = await db.select().from(reigns).where(isNull(reigns.endedAt)).limit(1);

  const retinueRows = await db
    .select()
    .from(reigns)
    .where(isNotNull(reigns.endedAt))
    .orderBy(desc(reigns.endedAt))
    .limit(8);

  return {
    champion: champion ? { occupantId: champion.occupantId, priceCents: champion.priceCents, since: champion.startedAt } : null,
    retinue: retinueRows.map((r) => ({
      occupantId: r.occupantId,
      priceCents: r.priceCents,
      startedAt: r.startedAt,
      endedAt: r.endedAt!,
    })),
  };
}

export async function getLeaderboard() {
  const ended = await db.select().from(reigns).where(isNotNull(reigns.endedAt));

  const byOccupant = new Map<string, { rounds: number; totalSpentCents: number; totalDurationMs: number }>();
  for (const r of ended) {
    const entry = byOccupant.get(r.occupantId) ?? { rounds: 0, totalSpentCents: 0, totalDurationMs: 0 };
    entry.rounds += 1;
    entry.totalSpentCents += r.priceCents;
    entry.totalDurationMs += r.endedAt!.getTime() - r.startedAt.getTime();
    byOccupant.set(r.occupantId, entry);
  }

  return [...byOccupant.entries()]
    .map(([occupantId, stats]) => ({ occupantId, ...stats }))
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs);
}
