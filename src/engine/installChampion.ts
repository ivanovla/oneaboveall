import { eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { reigns, rounds } from "../db/schema";
import { type Reign } from "../db/repository";

const SERIALIZATION_FAILURE = "40001";

export async function installChampion(
  occupantId: string,
  priceCents: number,
  now: Date,
  onInstalled?: (occupantId: string) => void,
  { onRetry }: { onRetry?: () => void } = {},
): Promise<Reign> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const reign = await db.transaction(
        async (tx) => {
          const [current] = await tx
            .select()
            .from(reigns)
            .where(isNull(reigns.endedAt))
            .limit(1);
          if (current) {
            await tx.update(reigns).set({ endedAt: now }).where(eq(reigns.id, current.id));
          }

          const [inserted] = await tx
            .insert(reigns)
            .values({ occupantId, priceCents, startedAt: now })
            .returning();

          await tx.insert(rounds).values({ reignId: inserted.id, startsAt: now, phase: "bidding" });

          return inserted;
        },
        { isolationLevel: "serializable" },
      );

      onInstalled?.(occupantId);
      return reign;
    } catch (err: any) {
      if (err?.code === SERIALIZATION_FAILURE && attempt < maxAttempts) {
        onRetry?.();
        continue;
      }
      throw err;
    }
  }
  throw new Error("installChampion: exceeded retry attempts under serialization conflict");
}
