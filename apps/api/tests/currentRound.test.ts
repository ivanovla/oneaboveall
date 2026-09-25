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
    expect(body.biddingClosesAt).toBe("2026-09-22T12:00:00.000Z");
  });

  // Every homepage visitor polls this route (AuctionFlow.tsx's live
  // price/countdown), so at real scale it's the highest-traffic route in the
  // service — a short public cache-control lets any reverse proxy or CDN in
  // front absorb concurrent load before it ever reaches this process.
  it("sets a short public cache-control header matching the in-process cache TTL", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/current-round" });

    expect(response.headers["cache-control"]).toBe("public, max-age=1");
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

  it("does not permanently poison the cache after a transient DB failure", async () => {
    const { getCurrentRoundInfo } = await import("engine/queries/publicScene");
    vi.mocked(getCurrentRoundInfo).mockClear();
    vi.mocked(getCurrentRoundInfo).mockRejectedValueOnce(new Error("DB connection blip"));

    const app = buildServer();
    const failed = await app.inject({ method: "GET", url: "/current-round" });
    expect(failed.statusCode).toBe(500);

    vi.mocked(getCurrentRoundInfo).mockResolvedValueOnce({
      roundId: "round-2",
      phase: "bidding",
      currentLeaderCents: 200_000,
      biddingClosesAt: new Date("2026-09-23T13:00:00.000Z"),
    });

    const recovered = await app.inject({ method: "GET", url: "/current-round" });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().roundId).toBe("round-2");
    expect(vi.mocked(getCurrentRoundInfo)).toHaveBeenCalledTimes(2);
  });
});
