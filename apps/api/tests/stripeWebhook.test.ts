import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildServer } from "../src/server";

// vi.mock factories are hoisted above every top-level statement — including
// the `import { buildServer } from "../src/server"` above, which transitively
// imports the two modules mocked below. Plain top-level `const`s would still
// be in their temporal dead zone when those factories run, so the shared spies
// must be declared with vi.hoisted(). (Same reasoning as joinRound.test.ts.)
const { constructEvent, joinRoundMock, createRefund } = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  joinRoundMock: vi.fn(async () => ({ outcome: "joined" as const })),
  createRefund: vi.fn(async () => ({ id: "re_1" })),
}));

vi.mock("../src/stripeClient", () => ({
  stripe: { webhooks: { constructEvent }, refunds: { create: createRefund } },
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("engine/engine/joinRound", () => ({
  joinRound: joinRoundMock,
}));

describe("POST /webhooks/stripe", () => {
  // Both spies are module-level vi.fn()s shared by every test in this file, so
  // their call history has to be cleared between tests — otherwise the
  // `.not.toHaveBeenCalled()` assertions below would see calls left over from
  // an earlier test.
  beforeEach(() => {
    constructEvent.mockReset();
    joinRoundMock.mockReset();
    joinRoundMock.mockResolvedValue({ outcome: "joined" as const });
    createRefund.mockReset();
    createRefund.mockResolvedValue({ id: "re_1" });
  });

  it("rejects a request with no stripe-signature header", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/webhooks/stripe", payload: {} });
    expect(response.statusCode).toBe(400);
    // The signature check must happen before the event payload is trusted at
    // all — nothing may reach the engine on an unverified request.
    expect(constructEvent).not.toHaveBeenCalled();
    expect(joinRoundMock).not.toHaveBeenCalled();
  });

  it("rejects a request whose signature fails verification", async () => {
    constructEvent.mockImplementationOnce(() => {
      throw new Error("invalid signature");
    });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "bad" },
      payload: { hello: "world" },
    });
    expect(response.statusCode).toBe(400);
    expect(joinRoundMock).not.toHaveBeenCalled();
  });

  it("verifies the signature against the exact raw request bytes, not a re-serialized body", async () => {
    constructEvent.mockReturnValueOnce({ type: "payment_intent.created", data: { object: {} } });

    // Key order and whitespace that JSON.stringify(JSON.parse(raw)) would not
    // reproduce byte-for-byte — if the route ever verified against a
    // re-serialized body, every real Stripe delivery would fail to verify.
    const raw = '{"b":1,   "a":{"nested":  "x"}}';

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "valid", "content-type": "application/json" },
      payload: raw,
    });

    expect(response.statusCode).toBe(200);
    const [payload, signature, secret] = constructEvent.mock.calls[0];
    expect(Buffer.isBuffer(payload)).toBe(true);
    expect((payload as Buffer).toString("utf8")).toBe(raw);
    expect(signature).toBe("valid");
    expect(secret).toBe("whsec_test");
  });

  it("calls joinRound with the PaymentIntent's metadata and payment method on payment_intent.succeeded", async () => {
    constructEvent.mockReturnValueOnce({
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_1",
          amount: 1_000,
          payment_method: "pm_1",
          customer: "cus_1",
          metadata: { kind: "deposit", roundId: "round-1", bidderId: "challenger" },
        },
      },
    });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "valid" },
      payload: { irrelevant: "raw body is what's actually verified" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(joinRoundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        roundId: "round-1",
        bidderId: "challenger",
        depositCents: 1_000,
        depositRef: "pi_1",
        paymentMethodRef: "pm_1",
        customerRef: "cus_1",
      }),
      expect.anything(),
    );
  });

  it("accepts an expanded payment_method object, using its id", async () => {
    constructEvent.mockReturnValueOnce({
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_2",
          amount: 2_000,
          payment_method: { id: "pm_2", object: "payment_method" },
          customer: { id: "cus_2", object: "customer" },
          metadata: { kind: "deposit", roundId: "round-1", bidderId: "challenger" },
        },
      },
    });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "valid" },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(joinRoundMock).toHaveBeenCalledWith(
      expect.objectContaining({ depositRef: "pi_2", paymentMethodRef: "pm_2", customerRef: "cus_2" }),
      expect.anything(),
    );
  });

  it("does not call joinRound for a succeeded PaymentIntent that carries no round metadata", async () => {
    // The remainder off-session charge (StripePaymentProvider) also emits
    // payment_intent.succeeded. It carries no roundId/bidderId metadata, and
    // must never be mistaken for a deposit — doing so would hand it to
    // joinRound with a foreign depositRef, whose duplicate-join path would
    // refund the remainder charge we just collected.
    constructEvent.mockReturnValueOnce({
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_remainder", amount: 39_000, payment_method: "pm_1", metadata: {} } },
    });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "valid" },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(joinRoundMock).not.toHaveBeenCalled();
  });

  it("ignores event types it doesn't handle, still returning 200", async () => {
    constructEvent.mockReturnValueOnce({ type: "payment_intent.created", data: { object: {} } });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "valid" },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(joinRoundMock).not.toHaveBeenCalled();
  });

  it("returns a non-2xx when joinRound fails, so Stripe redelivers the event", async () => {
    constructEvent.mockReturnValueOnce({
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_3",
          amount: 1_000,
          payment_method: "pm_1",
          customer: "cus_1",
          metadata: { kind: "deposit", roundId: "round-1", bidderId: "challenger" },
        },
      },
    });
    joinRoundMock.mockRejectedValueOnce(new Error("database is down"));

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "valid" },
      payload: {},
    });

    // A 200 here would tell Stripe the deposit was successfully recorded when
    // it wasn't, and the event would never be redelivered.
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
  });

  it("ignores a succeeded PaymentIntent whose metadata lacks the kind=deposit marker", async () => {
    // Round metadata alone is not proof this is a deposit — any other
    // PaymentIntent this service ever creates could carry similar keys. The
    // explicit marker is what identifies a deposit.
    constructEvent.mockReturnValueOnce({
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_unmarked",
          amount: 1_000,
          payment_method: "pm_1",
          customer: "cus_1",
          metadata: { roundId: "round-1", bidderId: "challenger" },
        },
      },
    });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "valid" },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(joinRoundMock).not.toHaveBeenCalled();
    expect(createRefund).not.toHaveBeenCalled();
  });

  it.each([
    ["payment_method", { id: "pi_nopm", amount: 1_000, customer: "cus_1", metadata: { kind: "deposit", roundId: "round-1", bidderId: "challenger" } }],
    ["customer", { id: "pi_nocus", amount: 1_000, payment_method: "pm_1", metadata: { kind: "deposit", roundId: "round-1", bidderId: "challenger" } }],
  ])("refunds a collected deposit whose PaymentIntent has no %s, since it can never be joined", async (_field, object) => {
    // Without a participant row there is nothing that will ever refund this
    // charge — logging and walking away silently keeps the bidder's money.
    constructEvent.mockReturnValueOnce({ type: "payment_intent.succeeded", data: { object } });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "valid" },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(joinRoundMock).not.toHaveBeenCalled();
    expect(createRefund).toHaveBeenCalledWith({ payment_intent: (object as { id: string }).id });
  });

  it("returns a non-2xx when that refund itself fails, so Stripe redelivers", async () => {
    constructEvent.mockReturnValueOnce({
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_nopm",
          amount: 1_000,
          customer: "cus_1",
          metadata: { kind: "deposit", roundId: "round-1", bidderId: "challenger" },
        },
      },
    });
    createRefund.mockRejectedValueOnce(new Error("stripe unavailable"));

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "valid" },
      payload: {},
    });

    // Swallowing this would drop the refund permanently — the charge has no
    // participant row, so no other path in the system would ever retry it.
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
  });
});

// The raw-body capture above replaces Fastify's built-in application/json
// parser globally, so it has to preserve that parser's two guarantees for
// every POST route on this service — not just the webhook.
describe("application/json content-type parser", () => {
  // Every route below is reached before its handler runs: the parser rejects
  // these bodies, so the assertions hold regardless of route-level logic.
  const routes = ["/bids", "/rounds/round-1/join", "/webhooks/stripe"];

  it.each(routes)("rejects malformed JSON on %s with 400, not 500", async (url) => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    // A bare SyntaxError with no statusCode falls through to Fastify's
    // generic 500 handler, turning a client error into a false server-error
    // alert in production.
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Bad Request");
  });

  it.each(routes)("rejects a prototype-poisoning payload on %s with 400", async (url) => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      payload: '{"bidderId":"a","amountCents":1,"__proto__":{"polluted":"yes"}}',
    });

    expect(response.statusCode).toBe(400);
    // Assert the *parser* rejected this, not the route's own field
    // validation — several of these routes answer 400 for their own reasons,
    // which would make this test pass against a parser with no protection at
    // all. "Bad Request" is the Fastify error-handler shape for a thrown
    // parser SyntaxError; route-level 400s return their own `error` strings.
    expect(response.json().error).toBe("Bad Request");
    // Nothing may be polluted even in the rejected case.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each(routes)("rejects a constructor-poisoning payload on %s with 400", async (url) => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      payload: '{"bidderId":"a","constructor":{"prototype":{"polluted":"yes"}}}',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Bad Request");
  });
});
