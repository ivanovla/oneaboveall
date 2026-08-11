import { db } from "../db/client";
import { reigns, rounds } from "../db/schema";
import { getCurrentReign, type Reign } from "../db/repository";
import { STARTING_PRICE_CENTS } from "../domain/config";

export async function createInitialReign(occupantId: string, now: Date): Promise<Reign> {
  const existing = await getCurrentReign();
  if (existing) {
    throw new Error("A reign already exists; cannot bootstrap again.");
  }

  const [reign] = await db
    .insert(reigns)
    .values({ occupantId, priceCents: STARTING_PRICE_CENTS, startedAt: now })
    .returning();

  await db.insert(rounds).values({ reignId: reign.id, startsAt: now, phase: "bidding" });

  return reign;
}
