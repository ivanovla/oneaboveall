import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { rounds, roundParticipants } from "../db/schema";
import type { PaymentProvider } from "../payments/PaymentProvider";

const UNIQUE_VIOLATION = "23505";

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

  // The round can leave "bidding" between the user starting checkout and
  // Stripe's webhook actually confirming the charge (bidding-window close is
  // enforced on a 12h clock; webhook delivery is not instant). The deposit is
  // already charged by the time this function runs, so if that race happened,
  // record the participant as immediately refunded rather than silently
  // dropping money that was actually taken.
  const stillOpen = round.phase === "bidding";

  try {
    await db.insert(roundParticipants).values({
      roundId: params.roundId,
      bidderId: params.bidderId,
      depositCents: params.depositCents,
      depositRef: params.depositRef,
      paymentMethodRef: params.paymentMethodRef,
      depositStatus: stillOpen ? "held" : "refunded",
      joinedAt: params.now,
    });
  } catch (err: any) {
    if (err?.code === UNIQUE_VIOLATION) {
      // Stripe redelivered the payment_intent.succeeded webhook for a bidder
      // who already joined — safe no-op, not an error.
      return { outcome: "already-joined" };
    }
    throw err;
  }

  if (!stillOpen) {
    await provider.refund(params.depositRef);
    return { outcome: "refunded-round-closed" };
  }

  return { outcome: "joined" };
}
