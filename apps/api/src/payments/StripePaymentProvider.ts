import type Stripe from "stripe";
import type { PaymentProvider } from "engine/payments/PaymentProvider";

export class StripePaymentProvider implements PaymentProvider {
  constructor(
    private readonly stripe: Stripe,
    private readonly currency: string,
  ) {}

  async chargeRemainderOffSession(paymentMethodRef: string, amountCents: number): Promise<"succeeded" | "requires_action" | "failed"> {
    try {
      const intent = await this.stripe.paymentIntents.create({
        amount: amountCents,
        currency: this.currency,
        payment_method: paymentMethodRef,
        off_session: true,
        confirm: true,
      });

      if (intent.status === "succeeded") return "succeeded";
      if (intent.status === "requires_action") return "requires_action";
      return "failed";
    } catch (err: any) {
      // Stripe throws a StripeCardError for a synchronously-declined confirm
      // attempt; authentication_required is the specific code for "this
      // saved card still needs SCA" even off-session.
      if (err?.code === "authentication_required") return "requires_action";
      return "failed";
    }
  }

  async refund(depositRef: string): Promise<void> {
    await this.stripe.refunds.create({ payment_intent: depositRef });
  }
}
