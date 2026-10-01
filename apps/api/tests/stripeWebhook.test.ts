import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildServer } from "../src/server";

// vi.mock factories are hoisted above every top-level statement — including
// the `import { buildServer } from "../src/server"` above, which transitively
// imports the two modules mocked below. Plain top-level `const`s would still
// be in their temporal dead zone when those factories run, so the shared spies
// must be declared with vi.hoisted().
const { constructEvent, recordBidMock, createRefund } = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  recordBidMock: vi.fn(async () => ({ outcome: "recorded" as const })),
  createRefund: vi.fn(async () => ({ id: "re_1" })),
}));

vi.mock("../src/stripeClient", () => ({
  stripe: { webhooks: { constructEvent }, refunds: { create: createRefund } },
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("engine/engine/recordBid", () => ({
  recordBid: recordBidMock,
}));

describe("POST /webhooks/stripe", () => {
  // Both spies are module-level vi.fn()s shared by every test in this file, so
  // their call history has to be cleared between tests — otherwise the
  // `.not.toHaveBeenCalled()` assertions below would see calls left over from
  // an earlier test.
  beforeEach(() => {
    constructEvent.mockReset();
    recordBidMock.mockReset();
    recordBidMock.mockResolvedValue({ outcome: "recorded" as const });
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
    expect(recordBidMock).not.toHaveBeenCalled();
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
    expect(recordBidMock).not.toHaveBeenCalled();
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

  it("calls recordBid with the PaymentIntent's metadata on payment_intent.succeeded", async () => {
    constructEvent.mockReturnValueOnce({
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_1",
          amount: 11_000,
          metadata: { kind: "bid", roundId: "round-1", bidderId: "challenger", amountCents: "11000" },
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
    expect(recordBidMock).toHaveBeenCalledWith(
      { roundId: "round-1", bidderId: "challenger", amountCents: 11_000, paymentRef: "pi_1", now: expect.any(Date) },
      expect.anything(),
      expect.anything(),
    );
  });

  // The event a manual-capture PaymentIntent fires once the hold is in
  // place — the one that actually records every new bid. `succeeded` above
  // stays handled for PaymentIntents created before holds existed, and for
  // the event our own capture fires (a no-op: already recorded).
  it("calls recordBid the same way on payment_intent.amount_capturable_updated", async () => {
    constructEvent.mockReturnValueOnce({
      type: "payment_intent.amount_capturable_updated",
      data: {
        object: {
          id: "pi_hold",
          status: "requires_capture",
          amount: 11_000,
          amount_capturable: 11_000,
          metadata: { kind: "bid", roundId: "round-1", bidderId: "challenger", amountCents: "11000" },
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
    expect(recordBidMock).toHaveBeenCalledWith(
      { roundId: "round-1", bidderId: "challenger", amountCents: 11_000, paymentRef: "pi_hold", now: expect.any(Date) },
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not call recordBid for an amount_capturable_updated PaymentIntent without the kind=bid marker", async () => {
    constructEvent.mockReturnValueOnce({
      type: "payment_intent.amount_capturable_updated",
      data: { object: { id: "pi_other", amount: 5_000, metadata: { roundId: "round-1" } } },
    });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "valid" },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(recordBidMock).not.toHaveBeenCalled();
  });

  it("does not call recordBid for a succeeded PaymentIntent that carries no bid metadata", async () => {
    constructEvent.mockReturnValueOnce({
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_unmarked", amount: 39_000, metadata: {} } },
    });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "valid" },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(recordBidMock).not.toHaveBeenCalled();
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
    expect(recordBidMock).not.toHaveBeenCalled();
  });

  it("returns a non-2xx when recordBid fails, so Stripe redelivers the event", async () => {
    constructEvent.mockReturnValueOnce({
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_3",
          amount: 11_000,
          metadata: { kind: "bid", roundId: "round-1", bidderId: "challenger", amountCents: "11000" },
        },
      },
    });
    recordBidMock.mockRejectedValueOnce(new Error("database is down"));

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "valid" },
      payload: {},
    });

    // A 200 here would tell Stripe the bid was successfully recorded when it
    // wasn't, and the event would never be redelivered.
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
  });

  it("ignores a succeeded PaymentIntent whose metadata lacks the kind=bid marker", async () => {
    // Round metadata alone is not proof this is a bid — any other
    // PaymentIntent this service ever creates could carry similar keys. The
    // explicit marker is what identifies one.
    constructEvent.mockReturnValueOnce({
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_unmarked",
          amount: 11_000,
          metadata: { roundId: "round-1", bidderId: "challenger", amountCents: "11000" },
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
    expect(recordBidMock).not.toHaveBeenCalled();
    expect(createRefund).not.toHaveBeenCalled();
  });
});

// The raw-body capture above replaces Fastify's built-in application/json
// parser globally, so it has to preserve that parser's two guarantees for
// every POST route on this service — not just the webhook.
describe("application/json content-type parser", () => {
  // Every route below is reached before its handler runs: the parser rejects
  // these bodies, so the assertions hold regardless of route-level logic.
  const routes = ["/bids", "/webhooks/stripe"];

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
