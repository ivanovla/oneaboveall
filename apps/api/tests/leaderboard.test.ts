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
    { occupantId: "3f2b8c4e-9d01-4a7b-bd3c-1f1b0a2c9e77", occupantName: "Lena Ortiz", rounds: 6, totalSpentCents: 1_840_000, totalDurationMs: 950_400_000 },
    { occupantId: "6c21f7aa-0b4e-4f2c-9c1d-8a3e5d6b2f10", occupantName: "Bob Stone", rounds: 2, totalSpentCents: 500_000, totalDurationMs: 172_800_000 },
  ]),
}));

describe("GET /leaderboard", () => {
  it("returns the leaderboard rows as JSON, in the order the engine returned them", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/leaderboard" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(2);
    expect(body[0].occupantId).toBe("3f2b8c4e-9d01-4a7b-bd3c-1f1b0a2c9e77");
    expect(body[0].totalDurationMs).toBe(950_400_000);
    expect(body[1].occupantId).toBe("6c21f7aa-0b4e-4f2c-9c1d-8a3e5d6b2f10");
  });

  // Same reasoning as GET /scene: occupantId is a users.id UUID, so the row
  // must also carry the resolved display name for the public leaderboard.
  it("carries the resolved display name, not just the raw occupant UUID", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/leaderboard" });

    const body = response.json();
    expect(body[0].occupantName).toBe("Lena Ortiz");
    expect(body[0].occupantName).not.toMatch(/^[0-9a-f]{8}-/);
    expect(body[1].occupantName).toBe("Bob Stone");
  });
});
