import { describe, it, expect, vi } from "vitest";
import { StripePaymentProvider } from "../../src/payments/StripePaymentProvider";

function fakeStripe(overrides: Partial<{ createRefund: any }> = {}) {
  return {
    refunds: { create: overrides.createRefund ?? vi.fn() },
  } as any;
}

describe("StripePaymentProvider", () => {
  it("refund creates a Stripe refund for the given PaymentIntent", async () => {
    const createRefund = vi.fn(async () => ({}));
    const provider = new StripePaymentProvider(fakeStripe({ createRefund }));

    await provider.refund("pi_1");

    expect(createRefund).toHaveBeenCalledWith({ payment_intent: "pi_1" });
  });
});
