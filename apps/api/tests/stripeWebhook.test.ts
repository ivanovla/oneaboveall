import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildServer } from "../src/server";

// vi.mock factories are hoisted above every top-level statement — including
// the `import { buildServer } from "../src/server"` above, which transitively
// imports the two modules mocked below. Plain top-level `const`s would still
// be in their temporal dead zone when those factories run, so the shared spies
// must be declared with vi.hoisted(). (Same reasoning as joinRound.test.ts.)
const { constructEvent, joinRoundMock } = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  joinRoundMock: vi.fn(async () => ({ outcome: "joined" as const })),
}));

vi.mock("../src/stripeClient", () => ({
  stripe: { webhooks: { constructEvent } },
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
          metadata: { roundId: "round-1", bidderId: "challenger" },
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
    expect(joinRoundMock).toHaveBeenCalledWith(
      expect.objectContaining({ depositRef: "pi_2", paymentMethodRef: "pm_2" }),
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
          metadata: { roundId: "round-1", bidderId: "challenger" },
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
});
