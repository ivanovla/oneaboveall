import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("engine/queries/publicScene", () => ({
  getScene: vi.fn(async () => ({
    champion: { occupantId: "3f2b8c4e-9d01-4a7b-bd3c-1f1b0a2c9e77", occupantName: "Mark Vilensky", priceCents: 421_000, since: new Date("2026-08-09T10:20:00.000Z") },
    retinue: [
      { occupantId: "6c21f7aa-0b4e-4f2c-9c1d-8a3e5d6b2f10", occupantName: "Daniel Crowe", priceCents: 398_000, startedAt: new Date("2026-08-08T00:00:00.000Z"), endedAt: new Date("2026-08-09T00:00:00.000Z") },
    ],
  })),
}));

describe("GET /scene", () => {
  it("returns the current scene as JSON", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/scene" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.champion.occupantId).toBe("3f2b8c4e-9d01-4a7b-bd3c-1f1b0a2c9e77");
    expect(body.champion.priceCents).toBe(421_000);
    expect(body.champion.since).toBe("2026-08-09T10:20:00.000Z");
    expect(body.retinue).toHaveLength(1);
    expect(body.retinue[0].occupantId).toBe("6c21f7aa-0b4e-4f2c-9c1d-8a3e5d6b2f10");
  });

  // occupantId is a users.id UUID now that occupants sign in via OAuth. The
  // response must carry the human-readable name the engine resolved, or the
  // public homepage's champion banner renders a UUID.
  it("carries the resolved display name, not just the raw occupant UUID", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/scene" });

    const body = response.json();
    expect(body.champion.occupantName).toBe("Mark Vilensky");
    expect(body.champion.occupantName).not.toMatch(/^[0-9a-f]{8}-/);
    expect(body.retinue[0].occupantName).toBe("Daniel Crowe");
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
