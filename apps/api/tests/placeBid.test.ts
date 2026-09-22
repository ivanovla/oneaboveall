import { describe, it, expect, vi } from "vitest";
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

describe("POST /bids", () => {
  it("places a bid and returns its id", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/bids",
      payload: { bidderId: "challenger", amountCents: 11_000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ bidId: "bid-1" });
  });

  it("rejects a malformed body with 400", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/bids", payload: { bidderId: "challenger" } });
    expect(response.statusCode).toBe(400);
  });

  it("returns 422 with the engine's reason when placeBid rejects the bid", async () => {
    const { placeBid } = await import("engine/engine/placeBid");
    vi.mocked(placeBid).mockResolvedValueOnce({ ok: false, reason: "Join this round (pay the deposit) before placing a bid." });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/bids",
      payload: { bidderId: "challenger", amountCents: 11_000 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain("Join this round");
  });
});
