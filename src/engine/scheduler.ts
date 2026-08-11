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

    const result = await resolveBiddingPhaseSnapshot(round.id, snapshotAt);
    if (result.outcome === "empty-closed") {
      await startNextRound(round.reignId, round.startsAt);
    }
  }

  const duePendingOffers = await db
    .select()
    .from(paymentOffers)
    .where(and(eq(paymentOffers.status, "pending"), lte(paymentOffers.expiresAt, now)));

  for (const offer of duePendingOffers) {
    const [round] = await db.select().from(rounds).where(eq(rounds.id, offer.roundId)).limit(1);
    const result = await resolveExpiredOffer(offer.id, offer.expiresAt, provider);
    if (result.outcome === "round-closed") {
      await startNextRound(round.reignId, round.startsAt);
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
