import { describe, it, expect, vi } from "vitest";
import Stripe from "stripe";
import { StripePaymentProvider } from "../../src/payments/StripePaymentProvider";

type Overrides = Partial<{ retrieve: any; cancel: any; capture: any; createRefund: any }>;

function fakeStripe(overrides: Overrides = {}) {
  const stripe = {
    paymentIntents: {
      retrieve: overrides.retrieve ?? vi.fn(),
      cancel: overrides.cancel ?? vi.fn(async () => ({})),
      capture: overrides.capture ?? vi.fn(async () => ({ status: "succeeded" })),
    },
    refunds: { create: overrides.createRefund ?? vi.fn(async () => ({})) },
  };
  return stripe;
}

function intent(status: string, extra: Record<string, unknown> = {}) {
  return { id: "pi_1", status, amount: 11_000, ...extra };
}

describe("StripePaymentProvider.release", () => {
  it.each(["requires_capture", "requires_payment_method", "requires_confirmation", "requires_action"])(
    "cancels a PaymentIntent in %s (drops the hold, nothing was collected)",
    async (status) => {
      const stripe = fakeStripe({ retrieve: vi.fn(async () => intent(status)) });
      await new StripePaymentProvider(stripe as any).release("pi_1");
      expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
      expect(stripe.refunds.create).not.toHaveBeenCalled();
    },
  );

  it("refunds a PaymentIntent that was already collected (a pre-holds bid, or a captured one)", async () => {
    const stripe = fakeStripe({
      retrieve: vi.fn(async () => intent("succeeded", { latest_charge: { amount: 11_000, amount_refunded: 0, refunded: false } })),
    });
    await new StripePaymentProvider(stripe as any).release("pi_1");
    expect(stripe.refunds.create).toHaveBeenCalledWith({ payment_intent: "pi_1" }, { idempotencyKey: "release-pi_1" });
    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("does not refund a collected PaymentIntent that is already fully refunded", async () => {
    const stripe = fakeStripe({
      retrieve: vi.fn(async () => intent("succeeded", { latest_charge: { amount: 11_000, amount_refunded: 11_000, refunded: true } })),
    });
    await new StripePaymentProvider(stripe as any).release("pi_1");
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("tolerates Stripe reporting the charge as already refunded", async () => {
    const stripe = fakeStripe({
      retrieve: vi.fn(async () => intent("succeeded", { latest_charge: { amount: 11_000, amount_refunded: 0, refunded: false } })),
      createRefund: vi.fn(async () => {
        throw new Stripe.errors.StripeInvalidRequestError({ message: "already refunded", code: "charge_already_refunded" } as any);
      }),
    });
    await expect(new StripePaymentProvider(stripe as any).release("pi_1")).resolves.toBeUndefined();
  });

  it("is a no-op for an already-cancelled PaymentIntent", async () => {
    const stripe = fakeStripe({ retrieve: vi.fn(async () => intent("canceled")) });
    await new StripePaymentProvider(stripe as any).release("pi_1");
    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("expands the latest charge when retrieving, so the refunded check has the amounts", async () => {
    const retrieve = vi.fn(async () => intent("canceled"));
    await new StripePaymentProvider(fakeStripe({ retrieve }) as any).release("pi_1");
    expect(retrieve).toHaveBeenCalledWith("pi_1", { expand: ["latest_charge"] });
  });

  it("propagates a transient error so the caller retries", async () => {
    const stripe = fakeStripe({
      retrieve: vi.fn(async () => {
        throw new Stripe.errors.StripeConnectionError({ message: "network" } as any);
      }),
    });
    await expect(new StripePaymentProvider(stripe as any).release("pi_1")).rejects.toThrow();
  });
});

describe("StripePaymentProvider.capture", () => {
  it("captures a held PaymentIntent with a per-intent idempotency key", async () => {
    const stripe = fakeStripe({ retrieve: vi.fn(async () => intent("requires_capture")) });
    const result = await new StripePaymentProvider(stripe as any).capture("pi_1");
    expect(result).toEqual({ ok: true });
    expect(stripe.paymentIntents.capture).toHaveBeenCalledWith("pi_1", {}, { idempotencyKey: "capture-pi_1" });
  });

  it("reports ok without capturing again when the PaymentIntent already succeeded", async () => {
    const stripe = fakeStripe({ retrieve: vi.fn(async () => intent("succeeded")) });
    expect(await new StripePaymentProvider(stripe as any).capture("pi_1")).toEqual({ ok: true });
    expect(stripe.paymentIntents.capture).not.toHaveBeenCalled();
  });

  it.each(["canceled", "requires_payment_method", "requires_action", "processing"])(
    "reports a definitive failure for a PaymentIntent in %s",
    async (status) => {
      const stripe = fakeStripe({ retrieve: vi.fn(async () => intent(status)) });
      const result = await new StripePaymentProvider(stripe as any).capture("pi_1");
      expect(result).toEqual({ ok: false, reason: expect.stringContaining(status) });
      expect(stripe.paymentIntents.capture).not.toHaveBeenCalled();
    },
  );

  it("reports a definitive failure when Stripe declines the capture", async () => {
    const stripe = fakeStripe({
      retrieve: vi.fn(async () => intent("requires_capture")),
      capture: vi.fn(async () => {
        throw new Stripe.errors.StripeCardError({ message: "Your card was declined.", code: "card_declined" } as any);
      }),
    });
    const result = await new StripePaymentProvider(stripe as any).capture("pi_1");
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("declined") });
  });

  it("reports a definitive failure for an invalid-request error (e.g. the hold expired mid-capture)", async () => {
    const stripe = fakeStripe({
      retrieve: vi.fn(async () => intent("requires_capture")),
      capture: vi.fn(async () => {
        throw new Stripe.errors.StripeInvalidRequestError({ message: "unexpected state", code: "payment_intent_unexpected_state" } as any);
      }),
    });
    expect(await new StripePaymentProvider(stripe as any).capture("pi_1")).toEqual({ ok: false, reason: expect.any(String) });
  });

  it.each([
    ["connection", () => new Stripe.errors.StripeConnectionError({ message: "network" } as any)],
    ["API 5xx", () => new Stripe.errors.StripeAPIError({ message: "server error" } as any)],
    ["rate limit", () => new Stripe.errors.StripeRateLimitError({ message: "slow down" } as any)],
  ])("throws on a transient %s error so settlement retries next tick", async (_name, makeError) => {
    const stripe = fakeStripe({
      retrieve: vi.fn(async () => intent("requires_capture")),
      capture: vi.fn(async () => {
        throw makeError();
      }),
    });
    await expect(new StripePaymentProvider(stripe as any).capture("pi_1")).rejects.toThrow();
  });
});
