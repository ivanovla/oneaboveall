import { describe, it, expect, afterAll } from "vitest";
import { buildServer } from "../src/server";
import { pool } from "engine/db/client";
import { vi } from "vitest";

// Deliberately does NOT mock "../src/auth/requireSession": the other route
// tests stub it out to isolate their own logic, which means none of them can
// prove the real guard is actually wired into the real server. This file does
// exactly that, end to end, for every route that spends money or reveals a
// user's own state — an unauthenticated call must get a clean 401 from the
// guard, not a 500 or a 400 from some check further downstream.
vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

afterAll(async () => {
  await pool.end();
});

const guarded = [
  { method: "POST" as const, url: "/rounds/round-1/join", payload: {} },
  { method: "POST" as const, url: "/bids", payload: { amountCents: 11_000 } },
  { method: "GET" as const, url: "/rounds/round-1/me" },
];

describe("session guard on the money-moving and per-user routes", () => {
  for (const request of guarded) {
    it(`${request.method} ${request.url} returns 401 with no session cookie`, async () => {
      const app = buildServer();
      const response = await app.inject(request);

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "not signed in" });
    });

    it(`${request.method} ${request.url} returns 401 for a cookie that isn't a live session`, async () => {
      const app = buildServer();
      const response = await app.inject({
        ...request,
        headers: { cookie: "oneabobeall_session=not-a-real-token" },
      });

      expect(response.statusCode).toBe(401);
    });
  }

  // A bidderId in the body is no longer a credential of any kind: supplying
  // one must not buy a caller past the guard.
  it("a body bidderId does not get an unauthenticated caller past the guard", async () => {
    const app = buildServer();

    const join = await app.inject({
      method: "POST",
      url: "/rounds/round-1/join",
      payload: { bidderId: "victim" },
    });
    expect(join.statusCode).toBe(401);

    const bid = await app.inject({
      method: "POST",
      url: "/bids",
      payload: { bidderId: "victim", amountCents: 11_000 },
    });
    expect(bid.statusCode).toBe(401);
  });
});
