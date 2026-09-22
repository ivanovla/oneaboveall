import { and, eq, lte, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { reigns, rounds, paymentOffers, roundParticipants } from "../db/schema";
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
      if (!round) {
        // A foreign-key constraint makes this impossible in practice; without
        // the guard, the destructure below would throw a bare TypeError that
        // the catch reports as a confusing "failed to settle".
        console.error(`tick: payment offer ${offer.id} references missing round ${offer.roundId}; skipping`);
        continue;
      }
      const result = await settleRound(offer.id, now, provider);
      if (result.outcome === "round-closed") {
        await startNextRound(round.reignId, round.startsAt);
      }
    } catch (err) {
      console.error(`tick: failed to settle overdue payment offer ${offer.id}`, err);
    }
  }

  // Reconciliation sweep: a deposit still "held" on a round that has already
  // closed is money we owe back and nothing else will ever return. It can be
  // left behind by any of several partial failures — closeRoundAndRefundHeld
  // throwing part-way through its loop, joinRound's own race-refund call
  // failing after the row was inserted, or a process dying between the two.
  // Each of those paths is individually narrow; together they are the only
  // ways money gets stranded, and this one sweep retires all of them.
  const strandedDeposits = await db
    .select({ id: roundParticipants.id, depositRef: roundParticipants.depositRef })
    .from(roundParticipants)
    .innerJoin(rounds, eq(roundParticipants.roundId, rounds.id))
    .where(and(eq(roundParticipants.depositStatus, "held"), eq(rounds.phase, "closed")));

  for (const row of strandedDeposits) {
    try {
      // Refund first, mark second — the same ordering joinRound and
      // closeRoundAndRefundHeld use, and for the same reason: a crash between
      // the two must never leave the database claiming money was returned
      // when it wasn't, because nothing would ever revisit such a row. The
      // row staying "held" is the recoverable direction; this sweep simply
      // retries it on the next tick.
      //
      // The re-read immediately below, plus the conditional UPDATE after,
      // narrow (do not fully eliminate) a concurrent claim by
      // closeRoundAndRefundHeld — same narrowing joinRound documents. A
      // genuinely simultaneous claim costs at most one rejected duplicate
      // refund: Stripe refuses a second full refund on an already-refunded
      // PaymentIntent rather than paying it twice.
      const [current] = await db
        .select()
        .from(roundParticipants)
        .where(eq(roundParticipants.id, row.id))
        .limit(1);
      if (current?.depositStatus !== "held") continue; // another path got there first

      await provider.refund(row.depositRef);
      await db
        .update(roundParticipants)
        .set({ depositStatus: "refunded" })
        .where(and(eq(roundParticipants.id, row.id), eq(roundParticipants.depositStatus, "held")));
    } catch (err) {
      // Per-item isolation, as in both loops above: one participant's failed
      // refund must not stop the rest of the sweep.
      console.error(`tick: failed to refund stranded held deposit ${row.depositRef} (participant ${row.id})`, err);
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
