import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildServer } from "../src/server";

// vi.mock factories are hoisted above regular top-level code (including
// `import { buildServer } from "../src/server"`, which transitively pulls in
// the mocked "../src/stripeClient" below). A plain top-level
// `const createPaymentIntent = vi.fn(...)` would still be in its temporal
// dead zone when that hoisted mock factory runs, so it must be declared via
// vi.hoisted() to be hoisted together with the vi.mock calls.
const { createPaymentIntent, createCustomer } = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(async () => ({ client_secret: "pi_1_secret", id: "pi_1" })),
  createCustomer: vi.fn(async () => ({ id: "cus_1" })),
}));

vi.mock("engine/db/repository", () => ({
  getRoundParticipant: vi.fn(async () => null),
  getCurrentReign: vi.fn(async () => ({ id: "reign-1", occupantId: "champ", priceCents: 10_000, startedAt: new Date(), endedAt: null })),
  // By default, the current round is "round-1" — matching the `:id` the
  // happy-path/404(no reign)/409 tests below post to, so those tests still
  // reach the code paths they're testing now that the route verifies `:id`
  // against the actual current round.
  getLatestRound: vi.fn(async () => ({ id: "round-1", reignId: "reign-1", startsAt: new Date(), phase: "bidding" })),
  isBanned: vi.fn(async () => false),
}));

vi.mock("../src/stripeClient", () => ({
  stripe: { paymentIntents: { create: createPaymentIntent }, customers: { create: createCustomer } },
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

// bidderId is now derived from the session, not the request body — every
// test in this file signs in as "challenger" by default; the tests that need a
// different bidder (or no session at all) override this per-call.
// The real, DB-backed cookie→user lookup is covered by
// tests/auth/requireSession.test.ts, and the unmocked 401 wiring for this
// route by tests/routeAuthGuards.test.ts.
vi.mock("../src/auth/requireSession", () => ({
  requireSession: vi.fn(async () => ({ id: "challenger", email: "c@example.com", name: "C", photoPath: null, instagramUrl: null })),
}));

describe("POST /rounds/:id/join", () => {
  // createPaymentIntent is a module-level vi.fn() shared across every test in
  // this file (via vi.mock's hoisted factory), so its call history must be
  // cleared between tests — otherwise a later test's `.not.toHaveBeenCalled()`
  // would see calls left over from an earlier test.
  beforeEach(() => {
    createPaymentIntent.mockClear();
    createCustomer.mockClear();
  });

  it("creates a deposit PaymentIntent and returns its client secret", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.clientSecret).toBe("pi_1_secret");
    expect(body.depositCents).toBe(1_000); // 10% of the reign's 10_000 priceCents
    // The Customer is what makes setup_future_usage actually usable later:
    // Stripe refuses to reuse a saved PaymentMethod from a separate
    // PaymentIntent unless it is attached to a Customer that intent names.
    expect(createCustomer).toHaveBeenCalledWith({ metadata: { bidderId: "challenger" } });
    expect(createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1_000,
        customer: "cus_1",
        setup_future_usage: "off_session",
        metadata: { kind: "deposit", roundId: "round-1", bidderId: "challenger" },
      }),
    );
  });

  it("returns 401 when not signed in", async () => {
    const { requireSession } = await import("../src/auth/requireSession");
    vi.mocked(requireSession).mockImplementationOnce(async (_req, reply) => {
      reply.code(401);
      reply.send({ error: "not signed in" });
      return null;
    });

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join" });
    expect(response.statusCode).toBe(401);
    expect(createPaymentIntent).not.toHaveBeenCalled();
    expect(createCustomer).not.toHaveBeenCalled();
  });

  // This is the whole point of the task: before it, a bidderId in the body was
  // taken at face value, so anyone could make anyone else's saved card the one
  // on the hook for this round's deposit. A body bidderId must now be inert.
  it("ignores a bidderId smuggled in the request body and charges the session user", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/rounds/round-1/join",
      payload: { bidderId: "victim" },
    });

    expect(response.statusCode).toBe(200);
    expect(createCustomer).toHaveBeenCalledWith({ metadata: { bidderId: "challenger" } });
    expect(createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { kind: "deposit", roundId: "round-1", bidderId: "challenger" },
      }),
    );
  });

  it("checks the ban list and the duplicate-join guard against the session user, not the body", async () => {
    const { isBanned, getRoundParticipant } = await import("engine/db/repository");
    vi.mocked(isBanned).mockClear();
    vi.mocked(getRoundParticipant).mockClear();

    const app = buildServer();
    await app.inject({ method: "POST", url: "/rounds/round-1/join", payload: { bidderId: "victim" } });

    expect(isBanned).toHaveBeenCalledWith("challenger", expect.any(Date));
    expect(getRoundParticipant).toHaveBeenCalledWith("round-1", "challenger");
  });

  it("rejects with 404 when there's no active reign", async () => {
    const { getCurrentReign } = await import("engine/db/repository");
    vi.mocked(getCurrentReign).mockResolvedValueOnce(null);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join" });
    expect(response.statusCode).toBe(404);
  });

  it("rejects with 409 when this bidder already joined this round", async () => {
    const { getRoundParticipant } = await import("engine/db/repository");
    vi.mocked(getRoundParticipant).mockResolvedValueOnce({
      id: "p1", roundId: "round-1", bidderId: "challenger", depositCents: 1_000, depositRef: "pi_0", paymentMethodRef: "pm_0", customerRef: "cus_0", depositStatus: "held", joinedAt: new Date(),
    } as any);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join" });
    expect(response.statusCode).toBe(409);
  });

  it("rejects with 404 when the :id in the URL doesn't match any round", async () => {
    const { getLatestRound } = await import("engine/db/repository");
    vi.mocked(getLatestRound).mockResolvedValueOnce(null);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/nonexistent-round/join" });
    expect(response.statusCode).toBe(404);
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects with 404 when the :id in the URL is a real round but not the current one", async () => {
    const { getLatestRound } = await import("engine/db/repository");
    // The current round (derived server-side from the current reign) is
    // "round-2" — a caller posting to the stale/other "round-1" must not be
    // able to join, and must not trigger a PaymentIntent.
    vi.mocked(getLatestRound).mockResolvedValueOnce({ id: "round-2", reignId: "reign-1", startsAt: new Date(), phase: "bidding" } as any);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join" });
    expect(response.statusCode).toBe(404);
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it("defeats the duplicate-join bypass: varying :id between calls for the same bidder still gets a 404, not a second PaymentIntent", async () => {
    const { getLatestRound } = await import("engine/db/repository");
    // Current round is "round-1"; a second call to a different, made-up :id
    // for the same bidder must not sail past the duplicate-join guard by
    // simply finding no participant row under that other key.
    vi.mocked(getLatestRound).mockResolvedValueOnce({ id: "round-1", reignId: "reign-1", startsAt: new Date(), phase: "bidding" } as any);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/some-other-id/join" });
    expect(response.statusCode).toBe(404);
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects with 409 when the round's bidding window has already elapsed", async () => {
    const { getLatestRound } = await import("engine/db/repository");
    // Phase is still "bidding" — the scheduler has not snapshotted the round
    // yet — but the 12h window closed long ago. Charging here would make the
    // engine's race-refund path the normal path for anyone with a stale page.
    vi.mocked(getLatestRound).mockResolvedValueOnce({
      id: "round-1",
      reignId: "reign-1",
      startsAt: new Date(Date.now() - 13 * 60 * 60 * 1000),
      phase: "bidding",
    } as any);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join" });

    expect(response.statusCode).toBe(409);
    expect(createPaymentIntent).not.toHaveBeenCalled();
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it("rejects with 409 when the round has already left the bidding phase", async () => {
    const { getLatestRound } = await import("engine/db/repository");
    vi.mocked(getLatestRound).mockResolvedValueOnce({
      id: "round-1",
      reignId: "reign-1",
      startsAt: new Date(),
      phase: "resolving",
    } as any);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join" });

    expect(response.statusCode).toBe(409);
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects a banned bidder with 403 and takes no money", async () => {
    const { isBanned } = await import("engine/db/repository");
    const { requireSession } = await import("../src/auth/requireSession");
    // placeBid would reject every bid this bidder attempts, so the deposit
    // would just sit charged until the round closed and refunded it.
    vi.mocked(isBanned).mockResolvedValueOnce(true);
    vi.mocked(requireSession).mockResolvedValueOnce({ id: "banned-guy", email: "b@example.com", name: "B", photoPath: null, instagramUrl: null });

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join" });

    expect(response.statusCode).toBe(403);
    expect(createPaymentIntent).not.toHaveBeenCalled();
    expect(createCustomer).not.toHaveBeenCalled();
  });
});
