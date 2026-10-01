import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "./client";
import { refVisits, users } from "./schema";
import { ATTRIBUTION_FIELDS, type Attribution } from "../domain/attribution";

// Upsert-and-increment in one statement — same shape as incrementPageViews:
// two concurrent first visits through a brand-new ref can't race each other
// into a unique violation. `ref` must already be sanitized by the caller.
export async function incrementRefVisits(ref: string): Promise<number> {
  const [row] = await db
    .insert(refVisits)
    .values({ ref, count: 1 })
    .onConflictDoUpdate({ target: refVisits.ref, set: { count: sql`${refVisits.count} + 1` } })
    .returning();
  return row.count;
}

/**
 * Records a user's first-touch attribution — once. The `attributed_at IS
 * NULL` condition lives in the UPDATE itself rather than a read-then-write,
 * so two tabs both sending it right after sign-in can't both win, and a
 * later visit through another streamer's link can never overwrite the one
 * that actually brought this person in. An all-null attribution (every
 * value failed sanitization) records nothing, leaving the slot open.
 *
 * Returns whether this call was the one that recorded it.
 */
export async function setUserAttributionOnce(userId: string, attribution: Attribution, now: Date): Promise<boolean> {
  if (ATTRIBUTION_FIELDS.every((field) => attribution[field] === null)) return false;
  const updated = await db
    .update(users)
    .set({ ...attribution, attributedAt: now })
    .where(and(eq(users.id, userId), isNull(users.attributedAt)))
    .returning({ id: users.id });
  return updated.length > 0;
}

/** The user's stored attribution, for copying onto a bid's PaymentIntent. */
export async function getUserAttribution(userId: string): Promise<Attribution | null> {
  const [row] = await db
    .select({
      ref: users.ref,
      utmSource: users.utmSource,
      utmMedium: users.utmMedium,
      utmCampaign: users.utmCampaign,
      utmContent: users.utmContent,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}
