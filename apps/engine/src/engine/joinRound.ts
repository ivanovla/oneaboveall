import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { rounds, roundParticipants } from "../db/schema";
import { BIDDING_PHASE_MS } from "../domain/config";
import type { PaymentProvider } from "../payments/PaymentProvider";

const UNIQUE_VIOLATION = "23505";

// Mirrors the window check in placeBid.ts: a round keeps phase "bidding" from
// T0 until the scheduler's tick actually snapshots it, which can be well
// after T0 + BIDDING_PHASE_MS. Phase alone is not authoritative for whether
// the round is actually still open to new joins.
function isBiddingOpen(round: { phase: string; startsAt: Date }, now: Date): boolean {
  if (round.phase !== "bidding") return false;
  const biddingClosesAt = round.startsAt.getTime() + BIDDING_PHASE_MS;
  return round.startsAt.getTime() <= now.getTime() && now.getTime() < biddingClosesAt;
}

export async function joinRound(
  params: {
    roundId: string;
    bidderId: string;
    depositCents: number;
    depositRef: string;
    paymentMethodRef: string;
    now: Date;
  },
  provider: PaymentProvider,
): Promise<{ outcome: "joined" | "already-joined" | "refunded-round-closed" }> {
  const [round] = await db.select().from(rounds).where(eq(rounds.id, params.roundId)).limit(1);
  if (!round) throw new Error("Round not found.");

  // Always insert as "held", regardless of whether the round still looks
  // open. Baking "refunded" into the INSERT would let a crash between the
  // insert and the actual provider.refund() call leave the DB permanently
  // claiming money was returned when it never was — and a redelivered
  // webhook would then hit the unique-violation path below and never retry
  // the refund. "held" is the recoverable state the codebase's existing
  // close-time sweeps already know how to reconcile.
  let inserted: typeof roundParticipants.$inferSelect;
  try {
    const rows = await db
      .insert(roundParticipants)
      .values({
        roundId: params.roundId,
        bidderId: params.bidderId,
        depositCents: params.depositCents,
        depositRef: params.depositRef,
        paymentMethodRef: params.paymentMethodRef,
        depositStatus: "held",
        joinedAt: params.now,
      })
      .returning();
    inserted = rows[0];
  } catch (err: any) {
    if (err?.code === UNIQUE_VIOLATION) {
      // Stripe redelivered the payment_intent.succeeded webhook for a bidder
      // who already joined — safe no-op, not an error. But if the incoming
      // depositRef differs from the one already on file, this isn't a
      // redelivery of the SAME charge — it's a genuinely distinct
      // PaymentIntent (e.g. the bidder retried checkout in a second tab)
      // that has already been charged for real. The first join stands; the
      // second, redundant charge must not be silently dropped.
      const [existing] = await db
        .select()
        .from(roundParticipants)
        .where(and(eq(roundParticipants.roundId, params.roundId), eq(roundParticipants.bidderId, params.bidderId)))
        .limit(1);
      if (existing && existing.depositRef !== params.depositRef) {
        console.error(
          `joinRound: bidder ${params.bidderId} already joined round ${params.roundId} with depositRef ${existing.depositRef}; ` +
            `refunding redundant duplicate charge ${params.depositRef}`,
        );
        await provider.refund(params.depositRef);
      }
      return { outcome: "already-joined" };
    }
    throw err;
  }

  // Re-read the round's phase after the insert (not the value read before
  // it) and re-check the window against it. This catches two distinct
  // races: (a) the round's bidding window closing (phase still "bidding",
  // but past T0 + BIDDING_PHASE_MS) between checkout start and this call
  // (finding: no window check), and (b) resolveBiddingPhaseSnapshot claiming
  // the round concurrently, in the gap between our first read above and the
  // insert (finding: TOCTOU) — either way, the deposit was already charged
  // by Stripe by the time we get here, so it must be handed back rather than
  // silently stranding "joined" rights for a round that's no longer open.
  const [currentRound] = await db.select().from(rounds).where(eq(rounds.id, params.roundId)).limit(1);
  const stillOpen = !!currentRound && isBiddingOpen(currentRound, params.now);

  if (!stillOpen) {
    await provider.refund(params.depositRef);
    await db.update(roundParticipants).set({ depositStatus: "refunded" }).where(eq(roundParticipants.id, inserted.id));
    return { outcome: "refunded-round-closed" };
  }

  return { outcome: "joined" };
}
