import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("engine/queries/publicScene", () => ({
  getScene: vi.fn(async () => ({
    champion: { occupantId: "champ-1", priceCents: 421_000, since: new Date("2026-08-09T10:20:00.000Z") },
    retinue: [
      { occupantId: "retinue-1", priceCents: 398_000, startedAt: new Date("2026-08-08T00:00:00.000Z"), endedAt: new Date("2026-08-09T00:00:00.000Z") },
    ],
  })),
}));

describe("GET /scene", () => {
  it("returns the current scene as JSON", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/scene" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.champion.occupantId).toBe("champ-1");
    expect(body.champion.priceCents).toBe(421_000);
    expect(body.champion.since).toBe("2026-08-09T10:20:00.000Z");
    expect(body.retinue).toHaveLength(1);
    expect(body.retinue[0].occupantId).toBe("retinue-1");
  });

  it("returns a null champion as null, not omitted", async () => {
    const { getScene } = await import("engine/queries/publicScene");
    vi.mocked(getScene).mockResolvedValueOnce({ champion: null, retinue: [] });

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/scene" });

    expect(response.statusCode).toBe(200);
    expect(response.json().champion).toBeNull();
  });
});
