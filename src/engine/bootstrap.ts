import { isNull } from "drizzle-orm";
import { db } from "../db/client";
import { reigns, rounds } from "../db/schema";
import { type Reign } from "../db/repository";
import { STARTING_PRICE_CENTS } from "../domain/config";

const SERIALIZATION_FAILURE = "40001";

export async function createInitialReign(
  occupantId: string,
  now: Date,
  { onRetry }: { onRetry?: () => void } = {},
): Promise<Reign> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await db.transaction(
        async (tx) => {
          const [existing] = await tx
            .select()
            .from(reigns)
            .where(isNull(reigns.endedAt))
            .limit(1);
          if (existing) {
            throw new Error("A reign already exists; cannot bootstrap again.");
          }

          const [reign] = await tx
            .insert(reigns)
            .values({ occupantId, priceCents: STARTING_PRICE_CENTS, startedAt: now })
            .returning();

          await tx.insert(rounds).values({ reignId: reign.id, startsAt: now, phase: "bidding" });

          return reign;
        },
        { isolationLevel: "serializable" },
      );
    } catch (err: any) {
      if (err?.code === SERIALIZATION_FAILURE && attempt < maxAttempts) {
        onRetry?.();
        continue;
      }
      throw err;
    }
  }
  throw new Error("createInitialReign: exceeded retry attempts under serialization conflict");
}
