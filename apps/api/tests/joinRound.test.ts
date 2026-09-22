import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

// vi.mock factories are hoisted above regular top-level code (including
// `import { buildServer } from "../src/server"`, which transitively pulls in
// the mocked "../src/stripeClient" below). A plain top-level
// `const createPaymentIntent = vi.fn(...)` would still be in its temporal
// dead zone when that hoisted mock factory runs, so it must be declared via
// vi.hoisted() to be hoisted together with the vi.mock calls.
const { createPaymentIntent } = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(async () => ({ client_secret: "pi_1_secret", id: "pi_1" })),
}));

vi.mock("engine/db/repository", () => ({
  getRoundParticipant: vi.fn(async () => null),
  getCurrentReign: vi.fn(async () => ({ id: "reign-1", occupantId: "champ", priceCents: 10_000, startedAt: new Date(), endedAt: null })),
}));

vi.mock("../src/stripeClient", () => ({
  stripe: { paymentIntents: { create: createPaymentIntent } },
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

describe("POST /rounds/:id/join", () => {
  it("creates a deposit PaymentIntent and returns its client secret", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/rounds/round-1/join",
      payload: { bidderId: "challenger" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.clientSecret).toBe("pi_1_secret");
    expect(body.depositCents).toBe(1_000); // 10% of the reign's 10_000 priceCents
    expect(createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1_000, setup_future_usage: "off_session", metadata: { roundId: "round-1", bidderId: "challenger" } }),
    );
  });

  it("rejects a missing bidderId with 400", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join", payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("rejects with 404 when there's no active reign", async () => {
    const { getCurrentReign } = await import("engine/db/repository");
    vi.mocked(getCurrentReign).mockResolvedValueOnce(null);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join", payload: { bidderId: "challenger" } });
    expect(response.statusCode).toBe(404);
  });

  it("rejects with 409 when this bidder already joined this round", async () => {
    const { getRoundParticipant } = await import("engine/db/repository");
    vi.mocked(getRoundParticipant).mockResolvedValueOnce({
      id: "p1", roundId: "round-1", bidderId: "challenger", depositCents: 1_000, depositRef: "pi_0", paymentMethodRef: "pm_0", depositStatus: "held", joinedAt: new Date(),
    } as any);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join", payload: { bidderId: "challenger" } });
    expect(response.statusCode).toBe(409);
  });
});
