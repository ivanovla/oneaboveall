import { describe, it, expect, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "engine/db/client";
import { users, sessions } from "engine/db/schema";
import { createSession, getUserBySessionToken, deleteSession } from "../../src/auth/session";

afterEach(async () => {
  await db.delete(sessions);
  await db.delete(users);
});

afterAll(async () => {
  await pool.end();
});

async function seedUser() {
  const [user] = await db
    .insert(users)
    .values({ provider: "google", providerId: "g-1", email: "a@example.com", name: "A" })
    .returning();
  return user;
}

describe("createSession / getUserBySessionToken / deleteSession", () => {
  it("creates a session and resolves it back to the user", async () => {
    const user = await seedUser();
    const { token, expiresAt } = await createSession(user.id);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const resolved = await getUserBySessionToken(token);
    expect(resolved).toMatchObject({ id: user.id, email: "a@example.com", name: "A" });
  });

  it("returns null for an unknown token", async () => {
    expect(await getUserBySessionToken("does-not-exist")).toBeNull();
  });

  it("returns null for an expired session", async () => {
    const user = await seedUser();
    await db.insert(sessions).values({ token: "expired-tok", userId: user.id, expiresAt: new Date(Date.now() - 1000) });
    expect(await getUserBySessionToken("expired-tok")).toBeNull();
  });

  it("deleteSession removes the row so it no longer resolves", async () => {
    const user = await seedUser();
    const { token } = await createSession(user.id);
    await deleteSession(token);
    expect(await getUserBySessionToken(token)).toBeNull();
  });

  it("generates a different token on every call", async () => {
    const user = await seedUser();
    const a = await createSession(user.id);
    const b = await createSession(user.id);
    expect(a.token).not.toBe(b.token);
  });
});
