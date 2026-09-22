import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("engine/queries/publicScene", () => ({
  getScene: vi.fn(async () => ({ champion: null, retinue: [] })),
  getLeaderboard: vi.fn(async () => [
    { occupantId: "alice", rounds: 6, totalSpentCents: 1_840_000, totalDurationMs: 950_400_000 },
    { occupantId: "bob", rounds: 2, totalSpentCents: 500_000, totalDurationMs: 172_800_000 },
  ]),
}));

describe("GET /leaderboard", () => {
  it("returns the leaderboard rows as JSON, in the order the engine returned them", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/leaderboard" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(2);
    expect(body[0].occupantId).toBe("alice");
    expect(body[0].totalDurationMs).toBe(950_400_000);
    expect(body[1].occupantId).toBe("bob");
  });
});
