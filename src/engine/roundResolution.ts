import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { rounds, paymentOffers } from "../db/schema";
import { getQueueLeader } from "../db/repository";
import { PAYMENT_ATTEMPT_MS, ROUND_MS } from "../domain/config";

export async function resolveBiddingPhaseSnapshot(
  roundId: string,
  now: Date,
): Promise<{ outcome: "empty-closed" | "offer-created" }> {
  const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId)).limit(1);
  if (!round) throw new Error("Round not found.");

  const leader = await getQueueLeader(roundId);

  if (!leader) {
    await db.update(rounds).set({ phase: "closed" }).where(eq(rounds.id, roundId));
    return { outcome: "empty-closed" };
  }

  const roundBoundary = new Date(round.startsAt.getTime() + ROUND_MS);
  const attemptExpiry = new Date(now.getTime() + PAYMENT_ATTEMPT_MS);
  const expiresAt = attemptExpiry.getTime() < roundBoundary.getTime() ? attemptExpiry : roundBoundary;

  await db.insert(paymentOffers).values({
    roundId,
    bidId: leader.id,
    offeredAt: now,
    expiresAt,
    status: "pending",
  });
  await db.update(rounds).set({ phase: "payment" }).where(eq(rounds.id, roundId));

  return { outcome: "offer-created" };
}
