import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildServer } from "../src/server";

// See currentRound.test.ts — server.ts imports stripeClient.ts unconditionally,
// so every test that builds the app needs this mocked away unless it's
// actually testing Stripe behavior.
vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("engine/engine/placeBid", () => ({
  placeBid: vi.fn(async () => ({ ok: true, bidId: "bid-1" })),
}));

// bidderId is now derived from the session, not the request body. The real,
// DB-backed cookie→user lookup is covered by tests/auth/requireSession.test.ts,
// and the unmocked 401 wiring for this route by tests/routeAuthGuards.test.ts.
vi.mock("../src/auth/requireSession", () => ({
  requireSession: vi.fn(async () => ({ id: "challenger", email: "c@example.com", name: "C" })),
}));

describe("POST /bids", () => {
  beforeEach(async () => {
    const { placeBid } = await import("engine/engine/placeBid");
    vi.mocked(placeBid).mockClear();
  });

  it("places a bid and returns its id", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/bids",
      payload: { amountCents: 11_000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ bidId: "bid-1" });

    const { placeBid } = await import("engine/engine/placeBid");
    expect(placeBid).toHaveBeenCalledWith({ bidderId: "challenger", amountCents: 11_000, now: expect.any(Date) });
  });

  it("returns 401 when not signed in", async () => {
    const { requireSession } = await import("../src/auth/requireSession");
    const { placeBid } = await import("engine/engine/placeBid");
    vi.mocked(requireSession).mockImplementationOnce(async (_req, reply) => {
      reply.code(401);
      reply.send({ error: "not signed in" });
      return null;
    });

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/bids", payload: { amountCents: 11_000 } });
    expect(response.statusCode).toBe(401);
    expect(placeBid).not.toHaveBeenCalled();
  });

  // The reason this task exists: a bidderId in the body used to be taken at
  // face value, so anyone could place a bid in anyone else's name (and put
  // their deposit/card on the hook for it). It must now be inert.
  it("ignores a bidderId smuggled in the request body and bids as the session user", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/bids",
      payload: { bidderId: "victim", amountCents: 11_000 },
    });

    expect(response.statusCode).toBe(200);
    const { placeBid } = await import("engine/engine/placeBid");
    expect(placeBid).toHaveBeenCalledWith({ bidderId: "challenger", amountCents: 11_000, now: expect.any(Date) });
  });

  it("rejects a malformed body with 400", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/bids", payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("returns 422 with the engine's reason when placeBid rejects the bid", async () => {
    const { placeBid } = await import("engine/engine/placeBid");
    vi.mocked(placeBid).mockResolvedValueOnce({ ok: false, reason: "Join this round (pay the deposit) before placing a bid." });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/bids",
      payload: { amountCents: 11_000 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain("Join this round");
  });
});
