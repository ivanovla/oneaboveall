import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { recordBid } from "engine/engine/recordBid";
import type { PaymentProvider } from "engine/payments/PaymentProvider";
import type { Notifier } from "engine/notifications/Notifier";

// Both events mean "this bid's money is secured": amount_capturable_updated
// fires when a manual-capture PaymentIntent's hold is placed (every bid
// since holds were introduced); succeeded fires for a PaymentIntent created
// before then, and again when settlement captures a winning hold. recordBid
// is idempotent on the PaymentIntent id, so receiving both for one bid is a
// no-op the second time. Both must be enabled on the Stripe webhook
// endpoint — see infra/README.md.
const BID_SECURED_EVENTS = new Set(["payment_intent.amount_capturable_updated", "payment_intent.succeeded"]);

export function registerStripeWebhookRoute(
  app: FastifyInstance,
  stripe: Stripe,
  webhookSecret: string,
  provider: PaymentProvider,
  notifier: Notifier,
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
    if (BID_SECURED_EVENTS.has(event.type)) {
      const intent = event.data.object as Stripe.PaymentIntent;
      const roundId = intent.metadata?.roundId;
      const bidderId = intent.metadata?.bidderId;
      const amountCents = intent.metadata?.amountCents ? Number(intent.metadata.amountCents) : null;

      if (intent.metadata?.kind !== "bid" || !roundId || !bidderId || !amountCents) {
        // Not a bid PaymentIntent — nothing else in this codebase creates
        // PaymentIntents any more, but ignoring an unrecognized one is still
        // the correct outcome rather than guessing at its shape. The `kind`
        // marker is what makes this positive identification rather than an
        // inference from which metadata keys happen to exist.
        request.log.info(
          { paymentIntentId: intent.id, eventType: event.type },
          "stripe webhook: PaymentIntent is not a bid (no kind=bid marker / metadata), ignoring",
        );
      } else {
        // recordBid is idempotent on paymentRef (the PaymentIntent id) via a
        // DB unique constraint, so a Stripe redelivery of this same event is
        // a safe no-op and needs no separate idempotency bookkeeping here.
        // Any exception is intentionally left to propagate: a 500 is what
        // makes Stripe redeliver, which is what a transient DB failure needs.
        const result = await recordBid(
          { roundId, bidderId, amountCents, paymentRef: intent.id, now: new Date() },
          provider,
          notifier,
        );
        request.log.info(
          { paymentIntentId: intent.id, eventType: event.type, roundId, bidderId, outcome: result.outcome },
          "stripe webhook: bid processed",
        );
      }
    }

    return { received: true };
  });
}
