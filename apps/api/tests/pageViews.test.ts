import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("engine/db/repository", () => ({
  incrementPageViews: vi.fn(async () => 42),
}));

describe("POST /page-views", () => {
  it("returns the incremented count as JSON", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/page-views" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ count: 42 });
  });
});
