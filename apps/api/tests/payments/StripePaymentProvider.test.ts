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

    const result = await provider.chargeRemainderOffSession("pm_1", 9_000);

    expect(result).toBe("succeeded");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9_000, currency: "usd", payment_method: "pm_1", off_session: true, confirm: true }),
    );
  });

  it("returns 'requires_action' when Stripe reports that status", async () => {
    const create = vi.fn(async () => ({ status: "requires_action" }));
    const provider = new StripePaymentProvider(fakeStripe({ create }), "usd");

    expect(await provider.chargeRemainderOffSession("pm_1", 9_000)).toBe("requires_action");
  });

  it("returns 'requires_action' when Stripe throws an authentication_required card error", async () => {
    const create = vi.fn(async () => {
      const err: any = new Error("authentication required");
      err.code = "authentication_required";
      throw err;
    });
    const provider = new StripePaymentProvider(fakeStripe({ create }), "usd");

    expect(await provider.chargeRemainderOffSession("pm_1", 9_000)).toBe("requires_action");
  });

  it("returns 'failed' for any other decline or error", async () => {
    const create = vi.fn(async () => {
      throw new Error("card_declined");
    });
    const provider = new StripePaymentProvider(fakeStripe({ create }), "usd");

    expect(await provider.chargeRemainderOffSession("pm_1", 9_000)).toBe("failed");
  });

  it("returns 'failed' when Stripe resolves with a non-succeeded, non-requires_action status", async () => {
    const create = vi.fn(async () => ({ status: "canceled" }));
    const provider = new StripePaymentProvider(fakeStripe({ create }), "usd");

    expect(await provider.chargeRemainderOffSession("pm_1", 9_000)).toBe("failed");
  });

  it("refund creates a Stripe refund for the deposit PaymentIntent", async () => {
    const createRefund = vi.fn(async () => ({}));
    const provider = new StripePaymentProvider(fakeStripe({ createRefund }), "usd");

    await provider.refund("pi_1");

    expect(createRefund).toHaveBeenCalledWith({ payment_intent: "pi_1" });
  });
});
