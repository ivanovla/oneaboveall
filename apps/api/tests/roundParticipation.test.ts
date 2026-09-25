import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("../src/auth/requireSession", () => ({
  requireSession: vi.fn(async () => ({ id: "bidder-1", email: "a@example.com", name: "A", photoPath: null, socialUrl: null })),
}));

vi.mock("engine/db/repository", () => ({
  getQueueLeader: vi.fn(async () => null),
}));

// rounds.id is a Postgres `uuid` column, so the route rejects ids that aren't
// UUID-shaped before querying — these tests use a real UUID so they exercise
// the same path production does.
const ROUND_ID = "11111111-1111-4111-8111-111111111111";

describe("GET /rounds/:id/me", () => {
  it("reports isLeading: true when this user's own bid is the queue's current top bid", async () => {
    const { getQueueLeader } = await import("engine/db/repository");
    vi.mocked(getQueueLeader).mockResolvedValueOnce({ id: "b1", roundId: ROUND_ID, bidderId: "bidder-1", amountCents: 5_000, placedAt: new Date() } as any);

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: `/rounds/${ROUND_ID}/me` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ isLeading: true });
  });

  it("reports isLeading: false when someone else's bid is the queue's current top bid", async () => {
    const { getQueueLeader } = await import("engine/db/repository");
    vi.mocked(getQueueLeader).mockResolvedValueOnce({ id: "b1", roundId: ROUND_ID, bidderId: "someone-else", amountCents: 5_000, placedAt: new Date() } as any);

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: `/rounds/${ROUND_ID}/me` });
    expect(response.json()).toEqual({ isLeading: false });
  });

  it("reports isLeading: false when there's no leader at all yet", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: `/rounds/${ROUND_ID}/me` });
    expect(response.json()).toEqual({ isLeading: false });
  });

  it("checks against the session user's id, not the URL", async () => {
    const { getQueueLeader } = await import("engine/db/repository");
    vi.mocked(getQueueLeader).mockResolvedValueOnce({ id: "b1", roundId: ROUND_ID, bidderId: "bidder-1", amountCents: 5_000, placedAt: new Date() } as any);

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: `/rounds/${ROUND_ID}/me` });

    expect(getQueueLeader).toHaveBeenCalledWith(ROUND_ID);
    expect(response.json()).toEqual({ isLeading: true });
  });

  // Without the shape check this reaches Postgres as `WHERE round_id =
  // 'not-a-uuid'` and comes back as a 500 with a database error, not a 400.
  it("rejects a round id that isn't UUID-shaped with 400, before touching the database", async () => {
    const { getQueueLeader } = await import("engine/db/repository");
    vi.mocked(getQueueLeader).mockClear();

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/rounds/not-a-uuid/me" });

    expect(response.statusCode).toBe(400);
    expect(getQueueLeader).not.toHaveBeenCalled();
  });

  it("returns 401 when not signed in", async () => {
    const { requireSession } = await import("../src/auth/requireSession");
    vi.mocked(requireSession).mockImplementationOnce(async (_req, reply) => {
      reply.code(401);
      reply.send({ error: "not signed in" });
      return null;
    });

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: `/rounds/${ROUND_ID}/me` });
    expect(response.statusCode).toBe(401);
  });

  // The guard must not become a way to probe round ids while signed out.
  it("returns 401, not 400, for a malformed round id when not signed in", async () => {
    const { requireSession } = await import("../src/auth/requireSession");
    vi.mocked(requireSession).mockImplementationOnce(async (_req, reply) => {
      reply.code(401);
      reply.send({ error: "not signed in" });
      return null;
    });

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/rounds/not-a-uuid/me" });
    expect(response.statusCode).toBe(401);
  });
});
