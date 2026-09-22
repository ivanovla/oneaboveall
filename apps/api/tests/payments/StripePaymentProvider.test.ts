import { describe, it, expect, vi } from "vitest";
import { StripePaymentProvider } from "../../src/payments/StripePaymentProvider";

function fakeStripe(overrides: Partial<{ create: any; createRefund: any }> = {}) {
  return {
    paymentIntents: { create: overrides.create ?? vi.fn() },
    refunds: { create: overrides.createRefund ?? vi.fn() },
  } as any;
}

describe("StripePaymentProvider", () => {
  it("returns 'succeeded' when Stripe confirms the off-session PaymentIntent as succeeded", async () => {
    const create = vi.fn(async () => ({ status: "succeeded" }));
    const provider = new StripePaymentProvider(fakeStripe({ create }), "usd");

    const result = await provider.chargeRemainderOffSession("cus_1", "pm_1", 9_000);

    expect(result).toBe("succeeded");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 9_000,
        currency: "usd",
        // Without the customer, Stripe rejects reuse of the saved payment
        // method with payment_method_unattached — the remainder charge for
        // every winner would fail.
        customer: "cus_1",
        payment_method: "pm_1",
        off_session: true,
        confirm: true,
      }),
    );
  });

  it("returns 'requires_action' when Stripe reports that status", async () => {
    const create = vi.fn(async () => ({ status: "requires_action" }));
    const provider = new StripePaymentProvider(fakeStripe({ create }), "usd");

    expect(await provider.chargeRemainderOffSession("cus_1", "pm_1", 9_000)).toBe("requires_action");
  });

  it("returns 'requires_action' when Stripe throws an authentication_required card error", async () => {
    const create = vi.fn(async () => {
      const err: any = new Error("authentication required");
      err.code = "authentication_required";
      throw err;
    });
    const provider = new StripePaymentProvider(fakeStripe({ create }), "usd");

    expect(await provider.chargeRemainderOffSession("cus_1", "pm_1", 9_000)).toBe("requires_action");
  });

  it("returns 'failed' for a genuine card decline", async () => {
    const create = vi.fn(async () => {
      const err: any = new Error("Your card was declined.");
      err.type = "StripeCardError";
      err.code = "card_declined";
      throw err;
    });
    const provider = new StripePaymentProvider(fakeStripe({ create }), "usd");

    expect(await provider.chargeRemainderOffSession("cus_1", "pm_1", 9_000)).toBe("failed");
  });

  // "failed" is not a neutral value: the engine forfeits the bidder's deposit
  // and bans them for three rounds on it. Only a real card error may produce
  // it — an outage, a rotated key, a rate limit or a malformed request is our
  // fault, and must surface as an exception the scheduler logs instead.
  it.each([
    ["StripeAuthenticationError", "api_key_expired"],
    ["StripeConnectionError", undefined],
    ["StripeRateLimitError", "rate_limit"],
    ["StripeInvalidRequestError", "payment_method_unattached"],
  ])("re-throws a %s instead of reporting it as a decline", async (type, code) => {
    const create = vi.fn(async () => {
      const err: any = new Error(String(type));
      err.type = type;
      if (code) err.code = code;
      throw err;
    });
    const provider = new StripePaymentProvider(fakeStripe({ create }), "usd");

    await expect(provider.chargeRemainderOffSession("cus_1", "pm_1", 9_000)).rejects.toThrow(String(type));
  });

  it("re-throws a plain, untyped error rather than treating it as a decline", async () => {
    const create = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const provider = new StripePaymentProvider(fakeStripe({ create }), "usd");

    await expect(provider.chargeRemainderOffSession("cus_1", "pm_1", 9_000)).rejects.toThrow("socket hang up");
  });

  it("returns 'failed' when Stripe resolves with a non-succeeded, non-requires_action status", async () => {
    const create = vi.fn(async () => ({ status: "canceled" }));
    const provider = new StripePaymentProvider(fakeStripe({ create }), "usd");

    expect(await provider.chargeRemainderOffSession("cus_1", "pm_1", 9_000)).toBe("failed");
  });

  it("refund creates a Stripe refund for the deposit PaymentIntent", async () => {
    const createRefund = vi.fn(async () => ({}));
    const provider = new StripePaymentProvider(fakeStripe({ createRefund }), "usd");

    await provider.refund("pi_1");

    expect(createRefund).toHaveBeenCalledWith({ payment_intent: "pi_1" });
  });
});
