import { and, eq, lte, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { reigns, rounds, paymentOffers } from "../db/schema";
import { resolveBiddingPhaseSnapshot, settleRound } from "./roundResolution";
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
      const result = await resolveBiddingPhaseSnapshot(round.id, snapshotAt, provider, now);
      if (result.outcome === "empty-closed") {
        await startNextRound(round.reignId, round.startsAt);
      } else if (result.outcome === "offer-created") {
        // The remainder charge is off-session and automatic — attempt it
        // (and follow any cascade) immediately, in this same tick, rather
        // than waiting for a bidder who was never going to be interactively
        // involved in the first place.
        const settled = await settleRound(result.offerId, now, provider);
        if (settled.outcome === "round-closed") {
          await startNextRound(round.reignId, round.startsAt);
        }
      }
      // result.outcome === "already-resolving": a concurrent caller (another
      // tick, or another worker instance) already claimed this round in the
      // same instant — that caller is responsible for driving it to
      // settlement, this one does nothing further.
    } catch (err) {
      // One round's failure (a transient DB error, a provider hiccup further
      // down the chain) must not abort the whole tick — the failing row gets
      // re-selected on every subsequent tick, so letting it propagate would
      // turn a transient blip into a permanent poison pill blocking every
      // other due round.
      console.error(`tick: failed to resolve bidding-phase snapshot for round ${round.id}`, err);
    }
  }

  // Crash-recovery safety net: in normal operation, settleRound above resolves
  // every offer the instant it's created, so nothing should still be "pending"
  // once its expiresAt has passed. This catches the rare case where a prior
  // process died between resolveBiddingPhaseSnapshot creating an offer and
  // settleRound ever being called on it (settleRound's own claim-before-charge
  // guard is what makes retrying it here safe).
  //
  // Known residual gap (not solved by this poll, and out of scope for this
  // plan — matches other narrow crash-window gaps already accepted elsewhere
  // in this codebase): if the process instead dies AFTER attemptOfferPayment
  // claims an offer to "processing" but BEFORE it finishes, the offer is
  // invisible to this poll (it only selects `status = "pending"`) and the
  // round is stuck in phase "payment" indefinitely — nothing currently
  // reclaims a stale "processing" offer, because doing so safely requires
  // reconciling against Stripe's own record of whether the charge actually
  // went through before retrying it (retrying blind risks a double charge).
  // A future hardening pass should add that reconciliation; this plan does
  // not attempt it.
  const duePendingOffers = await db
    .select()
    .from(paymentOffers)
    .where(and(eq(paymentOffers.status, "pending"), lte(paymentOffers.expiresAt, now)));

  for (const offer of duePendingOffers) {
    try {
      const [round] = await db.select().from(rounds).where(eq(rounds.id, offer.roundId)).limit(1);
      const result = await settleRound(offer.id, now, provider);
      if (result.outcome === "round-closed") {
        await startNextRound(round.reignId, round.startsAt);
      }
    } catch (err) {
      console.error(`tick: failed to settle overdue payment offer ${offer.id}`, err);
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
