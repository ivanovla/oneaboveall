import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildServer } from "../src/server";

const { paymentIntentCreate } = vi.hoisted(() => ({
  paymentIntentCreate: vi.fn(async () => ({ client_secret: "pi_1_secret" })),
}));

// See currentRound.test.ts — server.ts imports stripeClient.ts unconditionally,
// so every test that builds the app needs this mocked away unless it's
// actually testing Stripe behavior.
vi.mock("../src/stripeClient", () => ({
  stripe: { paymentIntents: { create: paymentIntentCreate } },
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("engine/engine/prepareBid", () => ({
  prepareBid: vi.fn(async () => ({ ok: true, roundId: "round-1" })),
}));

// bidderId is now derived from the session, not the request body. The real,
// DB-backed cookie→user lookup is covered by tests/auth/requireSession.test.ts,
// and the unmocked 401 wiring for this route by tests/routeAuthGuards.test.ts.
vi.mock("../src/auth/requireSession", () => ({
  requireSession: vi.fn(async () => ({ id: "challenger", email: "c@example.com", name: "C", photoPath: null, socialUrl: null })),
}));

describe("POST /bids", () => {
  beforeEach(async () => {
    const { prepareBid } = await import("engine/engine/prepareBid");
    vi.mocked(prepareBid).mockClear();
    paymentIntentCreate.mockClear();
  });

  it("creates a full-amount PaymentIntent and returns its client secret", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/bids",
      payload: { amountCents: 11_000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ clientSecret: "pi_1_secret" });

    expect(paymentIntentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 11_000,
        currency: "usd",
        metadata: expect.objectContaining({ kind: "bid", roundId: "round-1", bidderId: "challenger" }),
      }),
    );

    const { prepareBid } = await import("engine/engine/prepareBid");
    expect(prepareBid).toHaveBeenCalledWith({ bidderId: "challenger", amountCents: 11_000, now: expect.any(Date) });
  });

  it("returns 401 when not signed in", async () => {
    const { requireSession } = await import("../src/auth/requireSession");
    const { prepareBid } = await import("engine/engine/prepareBid");
    vi.mocked(requireSession).mockImplementationOnce(async (_req, reply) => {
      reply.code(401);
      reply.send({ error: "not signed in" });
      return null;
    });

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/bids", payload: { amountCents: 11_000 } });
    expect(response.statusCode).toBe(401);
    expect(prepareBid).not.toHaveBeenCalled();
    expect(paymentIntentCreate).not.toHaveBeenCalled();
  });

  // The reason this test exists: a bidderId in the body used to be taken at
  // face value, so anyone could bid (and charge a card) in anyone else's
  // name. It must now be inert.
  it("ignores a bidderId smuggled in the request body and bids as the session user", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/bids",
      payload: { bidderId: "victim", amountCents: 11_000 },
    });

    expect(response.statusCode).toBe(200);
    const { prepareBid } = await import("engine/engine/prepareBid");
    expect(prepareBid).toHaveBeenCalledWith({ bidderId: "challenger", amountCents: 11_000, now: expect.any(Date) });
  });

  it("rejects a malformed body with 400", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/bids", payload: {} });
    expect(response.statusCode).toBe(400);
    expect(paymentIntentCreate).not.toHaveBeenCalled();
  });

  it("returns 422 with the engine's reason when prepareBid rejects the bid, without ever charging", async () => {
    const { prepareBid } = await import("engine/engine/prepareBid");
    vi.mocked(prepareBid).mockResolvedValueOnce({ ok: false, reason: "This round is not accepting bids right now." });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/bids",
      payload: { amountCents: 11_000 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain("not accepting bids");
    expect(paymentIntentCreate).not.toHaveBeenCalled();
  });
});
