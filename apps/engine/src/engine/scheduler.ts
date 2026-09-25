import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { reigns, rounds } from "../db/schema";
import { resolveBiddingPhaseSnapshot } from "./roundResolution";
import { BIDDING_PHASE_MS } from "../domain/config";

export async function tick(now: Date, onInstalled?: (occupantId: string) => void): Promise<void> {
  const dueBiddingRounds = await db
    .select()
    .from(rounds)
    .where(eq(rounds.phase, "bidding"));

  for (const round of dueBiddingRounds) {
    const snapshotAt = new Date(round.startsAt.getTime() + BIDDING_PHASE_MS);
    if (now.getTime() < snapshotAt.getTime()) continue;

    try {
      const result = await resolveBiddingPhaseSnapshot(round.id, snapshotAt, onInstalled, now);
      if (result.outcome === "empty-closed") {
        // Nobody bid — the reign continues, so it needs a fresh round.
        await startNextRound(round.reignId, snapshotAt);
      }
      // result.outcome === "installed": installChampion already started the
      // new reign's first round itself — nothing more to do here.
      // result.outcome === "already-resolving": a concurrent caller (another
      // tick, or another worker instance) already claimed this round in the
      // same instant — that caller is responsible for whatever comes next.
    } catch (err) {
      // One round's failure (a transient DB error) must not abort the whole
      // tick — the failing row gets re-selected on every subsequent tick, so
      // letting it propagate would turn a transient blip into a permanent
      // poison pill blocking every other due round.
      console.error(`tick: failed to resolve bidding-phase snapshot for round ${round.id}`, err);
    }
  }
}

async function startNextRound(reignId: string, previousRoundClosedAt: Date): Promise<void> {
  const [reign] = await db.select().from(reigns).where(and(eq(reigns.id, reignId), isNull(reigns.endedAt))).limit(1);
  if (!reign) return; // reign already ended (a win just installed a new one) — no next round to start
  await db.insert(rounds).values({
    reignId,
    startsAt: previousRoundClosedAt,
    phase: "bidding",
  });
}
