import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("../src/auth/requireSession", () => ({
  requireSession: vi.fn(async () => ({ id: "bidder-1", email: "a@example.com", name: "A" })),
}));

// Only "bidder-1" has a participant row. The getCurrentReign / getLatestRound
// / isBanned entries aren't used by this route, but joinRound.ts imports them
// from the same module and server.ts registers it, so the factory has to
// provide the module's full surface.
vi.mock("engine/db/repository", () => ({
  getRoundParticipant: vi.fn(async (_roundId: string, bidderId: string) =>
    bidderId === "bidder-1" ? { id: "p1", roundId: ROUND_ID, bidderId: "bidder-1", depositCents: 1_000 } : null,
  ),
  getQueueLeader: vi.fn(async () => null),
  getCurrentReign: vi.fn(async () => null),
  getLatestRound: vi.fn(async () => null),
  isBanned: vi.fn(async () => false),
}));

// rounds.id is a Postgres `uuid` column, so the route rejects ids that aren't
// UUID-shaped before querying — these tests use a real UUID so they exercise
// the same path production does.
const { ROUND_ID } = vi.hoisted(() => ({ ROUND_ID: "11111111-1111-4111-8111-111111111111" }));

describe("GET /rounds/:id/me", () => {
  it("returns joined: true with the held deposit amount when the signed-in user has a participant row", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: `/rounds/${ROUND_ID}/me` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ joined: true, depositCents: 1_000, isLeading: false });
  });

  it("reports isLeading: true when this user's own bid is the queue's current top bid", async () => {
    const { getQueueLeader } = await import("engine/db/repository");
    vi.mocked(getQueueLeader).mockResolvedValueOnce({ id: "b1", roundId: ROUND_ID, bidderId: "bidder-1", amountCents: 5_000, placedAt: new Date() } as any);

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: `/rounds/${ROUND_ID}/me` });
    expect(response.json()).toEqual({ joined: true, depositCents: 1_000, isLeading: true });
  });

  it("reports isLeading: false when someone else's bid is the queue's current top bid", async () => {
    const { getQueueLeader } = await import("engine/db/repository");
    vi.mocked(getQueueLeader).mockResolvedValueOnce({ id: "b1", roundId: ROUND_ID, bidderId: "someone-else", amountCents: 5_000, placedAt: new Date() } as any);

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: `/rounds/${ROUND_ID}/me` });
    expect(response.json()).toEqual({ joined: true, depositCents: 1_000, isLeading: false });
  });

  // The participant row for "bidder-1" still exists — this must report on the
  // *caller*, not on whether anyone at all has joined the round.
  it("returns joined: false when they don't", async () => {
    const { requireSession } = await import("../src/auth/requireSession");
    vi.mocked(requireSession).mockResolvedValueOnce({ id: "someone-else", email: "x@example.com", name: "X" });

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: `/rounds/${ROUND_ID}/me` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ joined: false });
  });

  it("looks the participant row up under the session user's id, not the URL", async () => {
    const { getRoundParticipant } = await import("engine/db/repository");
    vi.mocked(getRoundParticipant).mockClear();

    const app = buildServer();
    await app.inject({ method: "GET", url: `/rounds/${ROUND_ID}/me` });

    expect(getRoundParticipant).toHaveBeenCalledWith(ROUND_ID, "bidder-1");
  });

  // Without the shape check this reaches Postgres as `WHERE round_id =
  // 'not-a-uuid'` and comes back as a 500 with a database error, not a 400.
  it("rejects a round id that isn't UUID-shaped with 400, before touching the database", async () => {
    const { getRoundParticipant } = await import("engine/db/repository");
    vi.mocked(getRoundParticipant).mockClear();

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/rounds/not-a-uuid/me" });

    expect(response.statusCode).toBe(400);
    expect(getRoundParticipant).not.toHaveBeenCalled();
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
