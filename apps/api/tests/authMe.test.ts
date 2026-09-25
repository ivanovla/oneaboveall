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

describe("PATCH /auth/social", () => {
  it("returns 401 with no session cookie", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "PATCH", url: "/auth/social", payload: { socialUrl: "https://instagram.com/someone" } });
    expect(response.statusCode).toBe(401);
  });

  it("saves a valid URL, whatever platform it points to", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-6", email: "f@example.com", name: "F" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/auth/social",
      headers: { cookie: `oneabobeall_session=${token}` },
      // Not Instagram — the whole point is that any social network (or
      // personal site) is accepted, not just one platform.
      payload: { socialUrl: "https://x.com/someone" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ socialUrl: "https://x.com/someone" });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.socialUrl).toBe("https://x.com/someone");
  });

  it("clears a previously-set link when given an empty string", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-7", email: "g@example.com", name: "G", socialUrl: "https://instagram.com/old" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/auth/social",
      headers: { cookie: `oneabobeall_session=${token}` },
      payload: { socialUrl: "" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ socialUrl: null });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.socialUrl).toBeNull();
  });

  it("rejects a non-URL value with 400, and does not touch the stored value", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-8", email: "h@example.com", name: "H", socialUrl: "https://instagram.com/old" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/auth/social",
      headers: { cookie: `oneabobeall_session=${token}` },
      payload: { socialUrl: "not a url" },
    });

    expect(response.statusCode).toBe(400);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.socialUrl).toBe("https://instagram.com/old");
  });

  // The value ends up in an `href` on the public champion card — a
  // non-http(s) scheme like `javascript:` must never be accepted.
  it("rejects a non-http(s) URL scheme with 400", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-9", email: "i@example.com", name: "I" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/auth/social",
      headers: { cookie: `oneabobeall_session=${token}` },
      payload: { socialUrl: "javascript:alert(1)" },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("PATCH /auth/character-request", () => {
  it("returns 401 with no session cookie", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "PATCH", url: "/auth/character-request", payload: { characterRequest: "Black suit, gold trim." } });
    expect(response.statusCode).toBe(401);
  });

  it("saves a freeform description and persists it", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-13", email: "m@example.com", name: "M" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/auth/character-request",
      headers: { cookie: `oneabobeall_session=${token}` },
      payload: { characterRequest: "Black suit, gold trim, confident pose." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ characterRequest: "Black suit, gold trim, confident pose." });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.characterRequest).toBe("Black suit, gold trim, confident pose.");
  });

  it("clears a previously-set description when given an empty string", async () => {
    const [user] = await db
      .insert(users)
      .values({ provider: "google", providerId: "g-14", email: "n@example.com", name: "N", characterRequest: "old request" })
      .returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/auth/character-request",
      headers: { cookie: `oneabobeall_session=${token}` },
      payload: { characterRequest: "" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ characterRequest: null });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.characterRequest).toBeNull();
  });

  it("rejects a description over 500 characters with 400, and does not touch the stored value", async () => {
    const [user] = await db
      .insert(users)
      .values({ provider: "google", providerId: "g-15", email: "o@example.com", name: "O", characterRequest: "original" })
      .returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/auth/character-request",
      headers: { cookie: `oneabobeall_session=${token}` },
      payload: { characterRequest: "x".repeat(501) },
    });

    expect(response.statusCode).toBe(400);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.characterRequest).toBe("original");
  });
});

describe("PATCH /auth/name", () => {
  it("returns 401 with no session cookie", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "PATCH", url: "/auth/name", payload: { name: "New Name" } });
    expect(response.statusCode).toBe(401);
  });

  it("updates the signed-in user's shown name and persists it", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-10", email: "j@example.com", name: "Old Name" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/auth/name",
      headers: { cookie: `oneabobeall_session=${token}` },
      payload: { name: "  New Name  " },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: user.id, name: "New Name" });
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.name).toBe("New Name");
  });

  it("rejects an empty (or whitespace-only) name with 400, and does not touch the stored value", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-11", email: "k@example.com", name: "Original" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/auth/name",
      headers: { cookie: `oneabobeall_session=${token}` },
      payload: { name: "   " },
    });

    expect(response.statusCode).toBe(400);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.name).toBe("Original");
  });

  it("rejects a name over 80 characters with 400", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-12", email: "l@example.com", name: "Original" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/auth/name",
      headers: { cookie: `oneabobeall_session=${token}` },
      payload: { name: "x".repeat(81) },
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
