import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { reigns, rounds } from "../db/schema";
import { resolveBiddingPhaseSnapshot } from "./roundResolution";
import { settleRound } from "./settlement";
import type { PaymentProvider } from "../payments/PaymentProvider";
import type { Notifier } from "../notifications/Notifier";
import { CHAMPION_PROCESSING_GAP_MS } from "../domain/config";
import { nextDailyCloseAt } from "../domain/dailyClose";

export type TickDeps = {
  // Needed to collect the winner's hold (and drop the others) at the close.
  provider: PaymentProvider;
  notifier?: Notifier;
  onInstalled?: (occupantId: string) => void;
};

export async function tick(now: Date, deps: TickDeps): Promise<void> {
  const { provider, notifier, onInstalled } = deps;
  const dueBiddingRounds = await db
    .select()
    .from(rounds)
    .where(eq(rounds.phase, "bidding"));

  for (const round of dueBiddingRounds) {
    const snapshotAt = nextDailyCloseAt(round.startsAt);
    if (now.getTime() < snapshotAt.getTime()) continue;

    try {
      // Settle first, the instant bidding has closed: collect the winner's
      // hold (falling back to the runner-up if that fails) and release the
      // rest. Re-run on every tick until the round is resolved — cheap and
      // side-effect-free once settled. A transient payment error throws to
      // the catch below with nothing changed, so the next tick retries.
      const settlement = await settleRound(round.id, snapshotAt, { provider, notifier }, now);

      // A round with a captured winner waits out CHAMPION_PROCESSING_GAP_MS
      // past snapshotAt before installation — the outgoing champion keeps
      // showing while the winner's artwork is prepared. A round where
      // nothing could be captured (no bids, or every hold failed) has nobody
      // to install and rolls into its reign's next round right away.
      if (settlement.outcome === "captured") {
        const installAt = new Date(snapshotAt.getTime() + CHAMPION_PROCESSING_GAP_MS);
        if (now.getTime() < installAt.getTime()) continue;
      }

      const result = await resolveBiddingPhaseSnapshot(round.id, snapshotAt, onInstalled, now);
      if (result.outcome === "empty-closed") {
        // Nobody won — the reign continues, so it needs a fresh round.
        await startNextRound(round.reignId, snapshotAt);
      }
      // result.outcome === "installed": installChampion already started the
      // new reign's first round itself — nothing more to do here.
      // result.outcome === "already-resolving": a concurrent caller (another
      // tick, or another worker instance) already claimed this round in the
      // same instant — that caller is responsible for whatever comes next.
    } catch (err) {
      // One round's failure (a transient DB or payment-provider error) must
      // not abort the whole tick — the failing row gets re-selected on every
      // subsequent tick, so letting it propagate would turn a transient blip
      // into a permanent poison pill blocking every other due round.
      console.error(`tick: failed to settle/resolve round ${round.id}`, err);
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
