import type Stripe from "stripe";
import type { PaymentProvider } from "engine/payments/PaymentProvider";

export class StripePaymentProvider implements PaymentProvider {
  constructor(
    private readonly stripe: Stripe,
    private readonly currency: string,
  ) {}

  async chargeRemainderOffSession(
    customerRef: string,
    paymentMethodRef: string,
    amountCents: number,
  ): Promise<"succeeded" | "requires_action" | "failed"> {
    try {
      const intent = await this.stripe.paymentIntents.create({
        amount: amountCents,
        currency: this.currency,
        // Required for reuse: Stripe only lets a saved PaymentMethod be
        // charged from a later, separate PaymentIntent when that intent names
        // the Customer the method is attached to. Omitting it fails with
        // payment_method_unattached — see the customerRef column on
        // roundParticipants.
        customer: customerRef,
        payment_method: paymentMethodRef,
        off_session: true,
        confirm: true,
      });

      if (intent.status === "succeeded") return "succeeded";
      if (intent.status === "requires_action") return "requires_action";
      return "failed";
    } catch (err: any) {
      // authentication_required is the specific card-error code for "this
      // saved card still needs SCA" even off-session.
      if (err?.code === "authentication_required") return "requires_action";
      // Only a genuine card error is a bidder failure. Everything else — a
      // rotated API key (StripeAuthenticationError), an outage
      // (StripeConnectionError), a rate limit, a malformed request
      // (StripeInvalidRequestError, e.g. an unattached payment method) — is
      // OUR failure, and mapping it to "failed" would make the engine forfeit
      // the bidder's deposit and ban them for something they did not do.
      // Re-throw instead: the scheduler's per-item try/catch logs it and moves
      // on, leaving the offer stuck rather than punishing an innocent bidder.
      if (err?.type === "StripeCardError") return "failed";
      throw err;
    }
  }

  async refund(depositRef: string): Promise<void> {
    await this.stripe.refunds.create({ payment_intent: depositRef });
  }
}
