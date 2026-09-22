import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { joinRound } from "engine/engine/joinRound";
import type { PaymentProvider } from "engine/payments/PaymentProvider";

export function registerStripeWebhookRoute(
  app: FastifyInstance,
  stripe: Stripe,
  webhookSecret: string,
  provider: PaymentProvider,
): void {
  app.post("/webhooks/stripe", async (request, reply) => {
    const signature = request.headers["stripe-signature"];
    if (!signature || typeof signature !== "string") {
      reply.code(400);
      return { error: "missing stripe-signature header" };
    }

    // Verify against the exact bytes Stripe signed. If the raw-body capture in
    // server.ts ever stops running for this route, rawBody is undefined and
    // there is nothing to verify — refuse explicitly rather than handing
    // constructEvent a stand-in payload. (An empty buffer would also fail
    // verification, so either way this fails closed, but a distinct 400 plus
    // this log makes a misconfigured parser diagnosable instead of looking
    // like a stream of bad signatures from Stripe.)
    const rawBody = request.rawBody;
    if (!rawBody) {
      request.log.error("stripe webhook: raw request body unavailable; cannot verify signature");
      reply.code(400);
      return { error: "raw body unavailable" };
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch {
      reply.code(400);
      return { error: "invalid signature" };
    }

    // Everything below this line reads a cryptographically verified payload.
    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object as Stripe.PaymentIntent;
      const roundId = intent.metadata?.roundId;
      const bidderId = intent.metadata?.bidderId;
      // Webhook payloads are never expanded, so payment_method arrives as a
      // bare id string; tolerate the object form anyway so an expansion
      // setting can never silently turn a collected deposit into a no-op.
      const paymentMethodRef =
        typeof intent.payment_method === "string" ? intent.payment_method : (intent.payment_method?.id ?? null);

      if (!roundId || !bidderId) {
        // Not a deposit PaymentIntent. The remainder off-session charge
        // (StripePaymentProvider.chargeRemainderOffSession) also emits
        // payment_intent.succeeded and deliberately carries no round
        // metadata — treating it as a deposit would pass joinRound a foreign
        // depositRef, and its duplicate-join branch would refund the
        // remainder we just collected. Ignoring it is the correct outcome.
        request.log.info(
          { paymentIntentId: intent.id },
          "stripe webhook: payment_intent.succeeded without round metadata; not a deposit, ignoring",
        );
      } else if (!paymentMethodRef) {
        // A deposit was genuinely collected but we can't save the payment
        // method needed to charge the remainder later. Retrying won't fix a
        // payload that simply lacks it, so this returns 200 (no redelivery
        // storm) and is escalated to the log instead.
        request.log.error(
          { paymentIntentId: intent.id, roundId, bidderId },
          "stripe webhook: deposit succeeded but PaymentIntent has no payment_method; bidder was charged and not joined",
        );
      } else {
        // joinRound is idempotent on (roundId, bidderId) via a DB unique
        // constraint, so a Stripe redelivery of this same event is a safe
        // no-op and needs no separate idempotency bookkeeping here. Any
        // exception is intentionally left to propagate: a 500 is what makes
        // Stripe redeliver, which is what a transient DB failure needs.
        const result = await joinRound(
          {
            roundId,
            bidderId,
            depositCents: intent.amount,
            depositRef: intent.id,
            paymentMethodRef,
            now: new Date(),
          },
          provider,
        );
        request.log.info(
          { paymentIntentId: intent.id, roundId, bidderId, outcome: result.outcome },
          "stripe webhook: deposit processed",
        );
      }
    }

    return { received: true };
  });
}
