import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "engine/db/client";
import { sessions, users } from "engine/db/schema";

export const SESSION_COOKIE_NAME = "oneabobeall_session";

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  await db.insert(sessions).values({ token, userId, expiresAt });
  return { token, expiresAt };
}

export async function getUserBySessionToken(
  token: string,
): Promise<{ id: string; email: string; name: string; photoPath: string | null; instagramUrl: string | null } | null> {
  const [row] = await db
    .select({ id: users.id, email: users.email, name: users.name, photoPath: users.photoPath, instagramUrl: users.instagramUrl })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function deleteSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token, token));
}
