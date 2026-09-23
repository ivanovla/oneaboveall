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

// Only "bidder-1" has a participant row for round-1. The getCurrentReign /
// getLatestRound / isBanned entries aren't used by this route, but
// joinRound.ts imports them from the same module and server.ts registers it,
// so the factory has to provide the module's full surface.
vi.mock("engine/db/repository", () => ({
  getRoundParticipant: vi.fn(async (_roundId: string, bidderId: string) =>
    bidderId === "bidder-1" ? { id: "p1", roundId: "round-1", bidderId: "bidder-1" } : null,
  ),
  getCurrentReign: vi.fn(async () => null),
  getLatestRound: vi.fn(async () => null),
  isBanned: vi.fn(async () => false),
}));

describe("GET /rounds/:id/me", () => {
  it("returns joined: true when the signed-in user has a participant row", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/rounds/round-1/me" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ joined: true });
  });

  // The participant row for "bidder-1" still exists — this must report on the
  // *caller*, not on whether anyone at all has joined the round.
  it("returns joined: false when they don't", async () => {
    const { requireSession } = await import("../src/auth/requireSession");
    vi.mocked(requireSession).mockResolvedValueOnce({ id: "someone-else", email: "x@example.com", name: "X" });

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/rounds/round-1/me" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ joined: false });
  });

  it("looks the participant row up under the session user's id, not the URL", async () => {
    const { getRoundParticipant } = await import("engine/db/repository");
    vi.mocked(getRoundParticipant).mockClear();

    const app = buildServer();
    await app.inject({ method: "GET", url: "/rounds/round-1/me" });

    expect(getRoundParticipant).toHaveBeenCalledWith("round-1", "bidder-1");
  });

  it("returns 401 when not signed in", async () => {
    const { requireSession } = await import("../src/auth/requireSession");
    vi.mocked(requireSession).mockImplementationOnce(async (_req, reply) => {
      reply.code(401);
      reply.send({ error: "not signed in" });
      return null;
    });

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/rounds/round-1/me" });
    expect(response.statusCode).toBe(401);
  });
});
