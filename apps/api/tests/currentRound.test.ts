import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";
import { beforeEach } from "vitest";
import { __resetCacheForTests } from "../src/routes/currentRound";

beforeEach(() => {
  __resetCacheForTests();
});

// Not testing anything Stripe-related here, but server.ts now imports
// stripeClient.ts unconditionally (Step 3 below), and that module throws at
// import time if STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET aren't set — mock it
// away so this test doesn't need real Stripe env vars just to build the app.
vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("engine/queries/publicScene", () => ({
  getCurrentRoundInfo: vi.fn(async () => ({
    roundId: "round-1",
    phase: "bidding",
    currentLeaderCents: 421_000,
    depositCents: 42_100,
    biddingClosesAt: new Date("2026-09-22T12:00:00.000Z"),
  })),
}));

describe("GET /current-round", () => {
  it("returns the current round info as JSON", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/current-round" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.roundId).toBe("round-1");
    expect(body.depositCents).toBe(42_100);
    expect(body.biddingClosesAt).toBe("2026-09-22T12:00:00.000Z");
  });

  it("returns null (not an error) when there's no active reign yet", async () => {
    const { getCurrentRoundInfo } = await import("engine/queries/publicScene");
    vi.mocked(getCurrentRoundInfo).mockResolvedValueOnce(null);

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/current-round" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
  });

  it("caches the result for concurrent requests within the TTL — the engine query runs only once", async () => {
    const { getCurrentRoundInfo } = await import("engine/queries/publicScene");
    vi.mocked(getCurrentRoundInfo).mockClear();
    vi.mocked(getCurrentRoundInfo).mockResolvedValue({
      roundId: "round-1",
      phase: "bidding",
      currentLeaderCents: 100_000,
      depositCents: 10_000,
      biddingClosesAt: new Date("2026-09-23T12:00:00.000Z"),
    });

    const app = buildServer();
    const [first, second] = await Promise.all([
      app.inject({ method: "GET", url: "/current-round" }),
      app.inject({ method: "GET", url: "/current-round" }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(vi.mocked(getCurrentRoundInfo)).toHaveBeenCalledTimes(1);
  });
});
