import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { buildServer } from "../src/server";
import { db, pool } from "engine/db/client";
import { users, sessions } from "engine/db/schema";
import { createSession } from "../src/auth/session";

// This file deliberately does NOT mock "../src/auth/requireSession": the
// other route tests stub it out to isolate their own logic, which means none
// of them can prove the real guard is actually wired into the real server.
// This one does exactly that, end to end against the real session table, for
// every route that spends money or reveals a user's own state — an
// unauthenticated call must get a clean 401 from the guard, not a 500 or a
// 400 from some check further downstream.

// stripeClient is still mocked, only because server.ts imports it
// unconditionally at build time (see currentRound.test.ts).
vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

// sessions before users: users.id is referenced by sessions.userId with no
// cascade configured.
afterEach(async () => {
  await db.delete(sessions);
  await db.delete(users);
});

afterAll(async () => {
  await pool.end();
});

const guarded = [
  { method: "POST" as const, url: "/bids", payload: { amountCents: 11_000 } },
  { method: "GET" as const, url: "/rounds/round-1/me" },
];

describe("session guard on the money-moving and per-user routes", () => {
  for (const request of guarded) {
    it(`${request.method} ${request.url} returns 401 with no session cookie`, async () => {
      const app = buildServer();
      const response = await app.inject(request);

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "not signed in" });
    });

    it(`${request.method} ${request.url} returns 401 for a cookie that isn't a live session`, async () => {
      const app = buildServer();
      const response = await app.inject({
        ...request,
        headers: { cookie: "oneaboveall_session=not-a-real-token" },
      });

      expect(response.statusCode).toBe(401);
    });
  }

  // A bidderId in the body is no longer a credential of any kind: supplying
  // one must not buy a caller past the guard.
  it("a body bidderId does not get an unauthenticated caller past the guard", async () => {
    const app = buildServer();

    const bid = await app.inject({
      method: "POST",
      url: "/bids",
      payload: { bidderId: "victim", amountCents: 11_000 },
    });
    expect(bid.statusCode).toBe(401);
  });

  // The signed-in half of GET /rounds/:id/me, with nothing mocked: a real
  // user, a real session cookie, and a real query against a round nobody has
  // joined. Proves the route answers cleanly rather than 500ing on the uuid
  // cast, which is what it did before the shape check was added.
  it("GET /rounds/:id/me answers for a real session without touching a mock", async () => {
    const [user] = await db
      .insert(users)
      .values({ provider: "google", providerId: "g-guard", email: "guard@example.com", name: "G" })
      .returning();
    const { token } = await createSession(user.id);
    const cookie = `oneaboveall_session=${token}`;

    const app = buildServer();

    const real = await app.inject({
      method: "GET",
      url: "/rounds/11111111-1111-4111-8111-111111111111/me",
      headers: { cookie },
    });
    expect(real.statusCode).toBe(200);
    expect(real.json()).toEqual({ isLeading: false });

    const malformed = await app.inject({ method: "GET", url: "/rounds/not-a-uuid/me", headers: { cookie } });
    expect(malformed.statusCode).toBe(400);
  });
});
