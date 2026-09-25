import { describe, it, expect, afterEach, afterAll } from "vitest";
import { buildServer } from "../src/server";
import { db, pool } from "engine/db/client";
import { users, sessions, reigns, rounds, bids } from "engine/db/schema";
import { createSession } from "../src/auth/session";

afterEach(async () => {
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(bids);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

describe("GET /me/history", () => {
  it("returns 401 with no session cookie", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/me/history" });
    expect(response.statusCode).toBe(401);
  });

  it("returns an empty history for a signed-in user who never bid on anything", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-hist-1", email: "a@example.com", name: "A" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/me/history", headers: { cookie: `oneaboveall_session=${token}` } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ history: [] });
  });

  it("returns only the signed-in user's own bids, not another bidder's", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-hist-2", email: "b@example.com", name: "B" }).returning();
    const { token } = await createSession(user.id);

    const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();
    await db.insert(bids).values([
      { roundId: round.id, bidderId: user.id, amountCents: 11_000, paymentRef: "pi_1" },
      { roundId: round.id, bidderId: "someone-else", amountCents: 12_000, paymentRef: "pi_2" },
    ]);

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/me/history", headers: { cookie: `oneaboveall_session=${token}` } });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.history).toHaveLength(1);
    expect(body.history[0].roundId).toBe(round.id);
    expect(body.history[0].bids).toEqual([{ amountCents: 11_000, placedAt: expect.any(String), status: "active" }]);
  });
});
