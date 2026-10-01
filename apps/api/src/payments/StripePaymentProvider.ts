import type Stripe from "stripe";
import type { CaptureResult, PaymentProvider } from "engine/payments/PaymentProvider";

// PaymentIntent statuses in which no money has moved yet — the hold either
// exists (requires_capture) or never got that far — so "release" means
// cancelling the intent.
const CANCELLABLE = new Set<Stripe.PaymentIntent.Status>([
  "requires_capture",
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
]);

// Stripe error classes that mean "this capture will never work", as
// opposed to connection errors, Stripe-side 5xx (StripeAPIError) and rate
// limits, which are worth retrying on the next scheduler tick. Matched on
// the SDK's `type` field (the error class name) rather than instanceof, so
// it holds for every copy of the SDK module that might be loaded.
const DEFINITIVE_CAPTURE_ERRORS = new Set(["StripeCardError", "StripeInvalidRequestError"]);

export class StripePaymentProvider implements PaymentProvider {
  constructor(private readonly stripe: Stripe) {}

  // Always reads the PaymentIntent's current state first rather than
  // guessing from our own records: a bid may be a hold (cancel it), a charge
  // from before holds existed (refund it), or already dropped by an earlier
  // attempt that crashed before recording so (nothing to do).
  async release(paymentRef: string): Promise<void> {
    const intent = await this.stripe.paymentIntents.retrieve(paymentRef, { expand: ["latest_charge"] });

    if (intent.status === "canceled") return;

    if (CANCELLABLE.has(intent.status)) {
      await this.stripe.paymentIntents.cancel(paymentRef);
      return;
    }

    if (intent.status === "succeeded") {
      const charge = intent.latest_charge;
      if (charge && typeof charge === "object" && (charge.refunded || charge.amount_refunded >= charge.amount)) {
        return; // already fully refunded — by us, earlier, or from the dashboard
      }
      try {
        // The idempotency key makes a retried release (after a crash between
        // this call and the caller recording it) return the same refund
        // instead of attempting a second one.
        await this.stripe.refunds.create({ payment_intent: paymentRef }, { idempotencyKey: `release-${paymentRef}` });
      } catch (err: any) {
        if (err?.code === "charge_already_refunded") return;
        throw err;
      }
      return;
    }

    // "processing" — not a state card payments sit in for long. Throwing
    // makes the caller leave the bid unreleased and try again later.
    throw new Error(`StripePaymentProvider.release: PaymentIntent ${paymentRef} is ${intent.status}; cannot release yet`);
  }

  async capture(paymentRef: string): Promise<CaptureResult> {
    const intent = await this.stripe.paymentIntents.retrieve(paymentRef);

    // Already collected: a pre-holds bid, or our own earlier capture that
    // crashed before settlement recorded it.
    if (intent.status === "succeeded") return { ok: true };
    if (intent.status !== "requires_capture") {
      return { ok: false, reason: `PaymentIntent is ${intent.status}, not capturable` };
    }

    try {
      // Fixed per-intent idempotency key: two overlapping settlement
      // attempts (or a retry after a timeout whose request actually landed)
      // collapse into one capture at Stripe.
      await this.stripe.paymentIntents.capture(paymentRef, {}, { idempotencyKey: `capture-${paymentRef}` });
      return { ok: true };
    } catch (err: any) {
      if (DEFINITIVE_CAPTURE_ERRORS.has(err?.type)) {
        return { ok: false, reason: [err.code, err.message].filter(Boolean).join(": ") || err.type };
      }
      throw err;
    }
  }
}
