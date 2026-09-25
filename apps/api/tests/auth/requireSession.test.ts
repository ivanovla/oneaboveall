import { describe, it, expect, afterEach, afterAll } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { db, pool } from "engine/db/client";
import { users, sessions } from "engine/db/schema";
import { createSession } from "../../src/auth/session";
import { requireSession } from "../../src/auth/requireSession";

// Same cleanup pattern as tests/auth/session.test.ts and tests/authMe.test.ts:
// unconditional afterEach cleanup (rather than inline deletes at the end of
// each test) so a failed assertion mid-test still leaves the DB clean for the
// next run, and sessions go before users to avoid the FK violation from
// users.id being referenced by sessions.userId.
afterEach(async () => {
  await db.delete(sessions);
  await db.delete(users);
});

afterAll(async () => {
  await pool.end();
});

describe("requireSession", () => {
  it("returns the user for a valid session cookie", async () => {
    const [user] = await db
      .insert(users)
      .values({ provider: "google", providerId: "g-3", email: "c@example.com", name: "C" })
      .returning();
    const { token } = await createSession(user.id);

    const app = Fastify();
    app.register(fastifyCookie);
    app.get("/test", async (request, reply) => {
      const resolved = await requireSession(request, reply);
      return resolved ?? {};
    });

    const response = await app.inject({
      method: "GET",
      url: "/test",
      headers: { cookie: `oneaboveall_session=${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: user.id, email: "c@example.com", name: "C" });
  });

  it("sets 401 and returns null with no session cookie", async () => {
    const app = Fastify();
    app.register(fastifyCookie);
    app.get("/test", async (request, reply) => {
      const resolved = await requireSession(request, reply);
      // Mirrors how the real routes call it: on null the 401 reply has
      // already been sent, so the handler just returns.
      if (!resolved) return;
      return resolved;
    });

    const response = await app.inject({ method: "GET", url: "/test" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "not signed in" });
  });

  it("sets 401 and returns null for a cookie whose token is not a live session", async () => {
    const app = Fastify();
    app.register(fastifyCookie);
    app.get("/test", async (request, reply) => {
      const resolved = await requireSession(request, reply);
      if (!resolved) return;
      return resolved;
    });

    const response = await app.inject({
      method: "GET",
      url: "/test",
      headers: { cookie: "oneaboveall_session=not-a-real-token" },
    });
    expect(response.statusCode).toBe(401);
  });
});
