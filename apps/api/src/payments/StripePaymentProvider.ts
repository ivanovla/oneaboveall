import type Stripe from "stripe";
import type { PaymentProvider } from "engine/payments/PaymentProvider";

export class StripePaymentProvider implements PaymentProvider {
  constructor(private readonly stripe: Stripe) {}

  async refund(paymentRef: string): Promise<void> {
    await this.stripe.refunds.create({ payment_intent: paymentRef });
  }
}
