import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildServer } from "../src/server";
import { db, pool } from "engine/db/client";
import { users } from "engine/db/schema";

const { paymentIntentCreate } = vi.hoisted(() => ({
  paymentIntentCreate: vi.fn(async () => ({ client_secret: "pi_1_secret" })),
}));

// See currentRound.test.ts — server.ts imports stripeClient.ts unconditionally,
// so every test that builds the app needs this mocked away unless it's
// actually testing Stripe behavior.
vi.mock("../src/stripeClient", () => ({
  stripe: { paymentIntents: { create: paymentIntentCreate } },
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("engine/engine/prepareBid", () => ({
  prepareBid: vi.fn(async () => ({ ok: true, roundId: "round-1" })),
}));

// bidderId is now derived from the session, not the request body. The real,
// DB-backed cookie→user lookup is covered by tests/auth/requireSession.test.ts,
// and the unmocked 401 wiring for this route by tests/routeAuthGuards.test.ts.
vi.mock("../src/auth/requireSession", () => ({
  requireSession: vi.fn(async () => ({ id: "challenger", email: "c@example.com", name: "C", photoPath: null, socialUrl: null })),
}));

// The route now writes to (users.terms_accepted_at) and reads from (the
// bidder's attribution) the real users row, so the mocked session user has
// to be a real row too — its id is swapped in per test below.
let sessionUserId = "";

afterEach(async () => {
  await db.delete(users);
});

afterAll(async () => {
  await pool.end();
});

describe("POST /bids", () => {
  beforeEach(async () => {
    const { prepareBid } = await import("engine/engine/prepareBid");
    vi.mocked(prepareBid).mockClear();
    paymentIntentCreate.mockClear();

    const [user] = await db
      .insert(users)
      .values({ provider: "google", providerId: "g-bid", email: "c@example.com", name: "C" })
      .returning();
    sessionUserId = user.id;
    const { requireSession } = await import("../src/auth/requireSession");
    vi.mocked(requireSession).mockImplementation(async () => ({
      id: sessionUserId,
      email: "c@example.com",
      name: "C",
      photoPath: null,
      socialUrl: null,
      characterRequest: null,
    }));
  });

  it("creates a full-amount, manual-capture PaymentIntent (an authorization hold) and returns its client secret", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/bids",
      payload: { amountCents: 11_000, acceptedTerms: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ clientSecret: "pi_1_secret" });

    expect(paymentIntentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 11_000,
        currency: "usd",
        // Only the round's winner is ever collected — see
        // engine/engine/settlement.ts. Everyone else's hold is released.
        capture_method: "manual",
        description: "oneaboveall.org seat bid",
        metadata: expect.objectContaining({ kind: "bid", roundId: "round-1", bidderId: sessionUserId }),
      }),
    );

    const { prepareBid } = await import("engine/engine/prepareBid");
    expect(prepareBid).toHaveBeenCalledWith({ bidderId: sessionUserId, amountCents: 11_000, now: expect.any(Date) });
  });

  it("returns 401 when not signed in", async () => {
    const { requireSession } = await import("../src/auth/requireSession");
    const { prepareBid } = await import("engine/engine/prepareBid");
    vi.mocked(requireSession).mockImplementationOnce(async (_req, reply) => {
      reply.code(401);
      reply.send({ error: "not signed in" });
      return null;
    });

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/bids", payload: { amountCents: 11_000, acceptedTerms: true } });
    expect(response.statusCode).toBe(401);
    expect(prepareBid).not.toHaveBeenCalled();
    expect(paymentIntentCreate).not.toHaveBeenCalled();
  });

  // The reason this test exists: a bidderId in the body used to be taken at
  // face value, so anyone could bid (and charge a card) in anyone else's
  // name. It must now be inert.
  it("ignores a bidderId smuggled in the request body and bids as the session user", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/bids",
      payload: { bidderId: "victim", amountCents: 11_000, acceptedTerms: true },
    });

    expect(response.statusCode).toBe(200);
    const { prepareBid } = await import("engine/engine/prepareBid");
    expect(prepareBid).toHaveBeenCalledWith({ bidderId: sessionUserId, amountCents: 11_000, now: expect.any(Date) });
  });

  it("rejects a malformed body with 400", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/bids", payload: {} });
    expect(response.statusCode).toBe(400);
    expect(paymentIntentCreate).not.toHaveBeenCalled();
  });

  it("returns 422 with the engine's reason when prepareBid rejects the bid, without ever charging", async () => {
    const { prepareBid } = await import("engine/engine/prepareBid");
    vi.mocked(prepareBid).mockResolvedValueOnce({ ok: false, reason: "This round is not accepting bids right now." });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/bids",
      payload: { amountCents: 11_000, acceptedTerms: true },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain("not accepting bids");
    expect(paymentIntentCreate).not.toHaveBeenCalled();
  });

  it("rejects a bid without acceptedTerms: true with 400, never placing a hold", async () => {
    const app = buildServer();
    for (const acceptedTerms of [undefined, false, "true", 1]) {
      const response = await app.inject({ method: "POST", url: "/bids", payload: { amountCents: 11_000, acceptedTerms } });
      expect(response.statusCode).toBe(400);
    }
    expect(paymentIntentCreate).not.toHaveBeenCalled();
    const [row] = await db.select().from(users).where(eq(users.id, sessionUserId));
    expect(row.termsAcceptedAt).toBeNull();
  });

  it("stamps terms_accepted_at on the first accepted bid only", async () => {
    const app = buildServer();
    await app.inject({ method: "POST", url: "/bids", payload: { amountCents: 11_000, acceptedTerms: true } });
    const [first] = await db.select().from(users).where(eq(users.id, sessionUserId));
    expect(first.termsAcceptedAt).toBeInstanceOf(Date);

    await app.inject({ method: "POST", url: "/bids", payload: { amountCents: 12_000, acceptedTerms: true } });
    const [second] = await db.select().from(users).where(eq(users.id, sessionUserId));
    expect(second.termsAcceptedAt).toEqual(first.termsAcceptedAt);
  });

  it("copies the bidder's ref/utm attribution into the PaymentIntent metadata, omitting empty fields", async () => {
    await db.update(users).set({ ref: "streamer_bob", utmSource: "twitch", attributedAt: new Date() }).where(eq(users.id, sessionUserId));

    const app = buildServer();
    await app.inject({ method: "POST", url: "/bids", payload: { amountCents: 11_000, acceptedTerms: true } });

    const metadata = (paymentIntentCreate.mock.calls[0] as unknown as [{ metadata: Record<string, string> }])[0].metadata;
    expect(metadata.ref).toBe("streamer_bob");
    expect(metadata.utm_source).toBe("twitch");
    expect(metadata).not.toHaveProperty("utm_medium");
    expect(metadata).not.toHaveProperty("utm_campaign");
    expect(metadata).not.toHaveProperty("utm_content");
  });

  it("sends no attribution keys for an unattributed bidder", async () => {
    const app = buildServer();
    await app.inject({ method: "POST", url: "/bids", payload: { amountCents: 11_000, acceptedTerms: true } });
    const metadata = (paymentIntentCreate.mock.calls[0] as unknown as [{ metadata: Record<string, string> }])[0].metadata;
    expect(Object.keys(metadata).sort()).toEqual(["amountCents", "bidderId", "kind", "roundId"]);
  });
});
