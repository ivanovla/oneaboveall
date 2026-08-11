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
    let reign: Reign;
    try {
      reign = await db.transaction(
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
    } catch (err: any) {
      if (err?.code === SERIALIZATION_FAILURE && attempt < maxAttempts) {
        onRetry?.();
        continue;
      }
      throw err;
    }

    // Deliberately outside the try/catch above: the transaction has already
    // committed at this point, so a throwing onInstalled must not be caught
    // and mistaken for a serialization conflict (which would re-run the
    // transaction and install a second, duplicate champion on top of the one
    // that already committed) and must not be swallowed into a false failure
    // report for an install that in fact succeeded.
    onInstalled?.(occupantId);
    return reign;
  }
  throw new Error("installChampion: exceeded retry attempts under serialization conflict");
}
