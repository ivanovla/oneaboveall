import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { buildServer } from "../src/server";
import { db, pool } from "engine/db/client";
import { users, sessions } from "engine/db/schema";
import { eq } from "drizzle-orm";
import { createSession } from "../src/auth/session";

vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

// Matches the cleanup pattern in tests/authGoogle.test.ts /
// tests/authApple.test.ts: unconditional afterEach cleanup (rather than
// inline cleanup at the end of each test) means a failed assertion mid-test
// still leaves the DB clean for the next run, and deleting `sessions` before
// `users` avoids the FK violation from users.id being referenced by
// sessions.userId (no cascade configured on that reference).
afterEach(async () => {
  await db.delete(sessions);
  await db.delete(users);
});

afterAll(async () => {
  await pool.end();
});

describe("GET /auth/me", () => {
  it("returns 401 with no session cookie", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/auth/me" });
    expect(response.statusCode).toBe(401);
  });

  it("returns the signed-in user for a valid session", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-1", email: "a@example.com", name: "A" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: `oneabobeall_session=${token}` } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: user.id, email: "a@example.com", name: "A" });
  });
});

describe("PATCH /auth/email", () => {
  it("returns 401 with no session cookie", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "PATCH", url: "/auth/email", payload: { email: "new@example.com" } });
    expect(response.statusCode).toBe(401);
  });

  it("updates the signed-in user's email and persists it", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-3", email: "old@example.com", name: "C" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/auth/email",
      headers: { cookie: `oneabobeall_session=${token}` },
      payload: { email: "new@example.com" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: user.id, email: "new@example.com" });

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.email).toBe("new@example.com");
  });

  it("rejects a value with no @ with 400, and does not touch the stored email", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-4", email: "old@example.com", name: "D" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/auth/email",
      headers: { cookie: `oneabobeall_session=${token}` },
      payload: { email: "not-an-email" },
    });

    expect(response.statusCode).toBe(400);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.email).toBe("old@example.com");
  });

  it("rejects a missing email field with 400", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-5", email: "old@example.com", name: "E" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/auth/email",
      headers: { cookie: `oneabobeall_session=${token}` },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("POST /auth/logout", () => {
  it("clears the session cookie and the sessions row", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-2", email: "b@example.com", name: "B" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: `oneabobeall_session=${token}` } });

    expect(response.statusCode).toBe(200);
    const rows = await db.select().from(sessions).where(eq(sessions.token, token));
    expect(rows).toHaveLength(0);
  });

  it("is a safe no-op with no session cookie", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/auth/logout" });
    expect(response.statusCode).toBe(200);
  });
});
