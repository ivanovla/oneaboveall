import { and, eq, lte, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { reigns, rounds, paymentOffers } from "../db/schema";
import { resolveBiddingPhaseSnapshot, resolveExpiredOffer } from "./roundResolution";
import { ROUND_MS, BIDDING_PHASE_MS } from "../domain/config";
import type { PaymentProvider } from "../payments/PaymentProvider";

export async function tick(now: Date, provider: PaymentProvider): Promise<void> {
  const dueBiddingRounds = await db
    .select()
    .from(rounds)
    .where(eq(rounds.phase, "bidding"));

  for (const round of dueBiddingRounds) {
    const snapshotAt = new Date(round.startsAt.getTime() + BIDDING_PHASE_MS);
    if (now.getTime() < snapshotAt.getTime()) continue;

    try {
      const result = await resolveBiddingPhaseSnapshot(round.id, snapshotAt);
      if (result.outcome === "empty-closed") {
        await startNextRound(round.reignId, round.startsAt);
      }
    } catch (err) {
      // One round's failure (a transient DB error, a provider hiccup further
      // down the chain) must not abort the whole tick — the failing row gets
      // re-selected on every subsequent tick, so letting it propagate would
      // turn a transient blip into a permanent poison pill blocking every
      // other due round.
      console.error(`tick: failed to resolve bidding-phase snapshot for round ${round.id}`, err);
    }
  }

  const duePendingOffers = await db
    .select()
    .from(paymentOffers)
    .where(and(eq(paymentOffers.status, "pending"), lte(paymentOffers.expiresAt, now)));

  for (const offer of duePendingOffers) {
    try {
      const [round] = await db.select().from(rounds).where(eq(rounds.id, offer.roundId)).limit(1);
      const result = await resolveExpiredOffer(offer.id, offer.expiresAt, provider);
      if (result.outcome === "round-closed") {
        await startNextRound(round.reignId, round.startsAt);
      }
    } catch (err) {
      // Same isolation rationale as the bidding-round loop above: an error
      // resolving one offer (e.g. a provider failure) must not block every
      // other due offer from being processed this tick or on future ticks.
      console.error(`tick: failed to resolve expired payment offer ${offer.id}`, err);
    }
  }
}

async function startNextRound(reignId: string, previousRoundStartsAt: Date): Promise<void> {
  const [reign] = await db.select().from(reigns).where(and(eq(reigns.id, reignId), isNull(reigns.endedAt))).limit(1);
  if (!reign) return; // reign already ended (a payment resolved it) — no next round to start
  await db.insert(rounds).values({
    reignId,
    startsAt: new Date(previousRoundStartsAt.getTime() + ROUND_MS),
    phase: "bidding",
  });
}
