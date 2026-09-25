import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { prepareBid } from "engine/engine/prepareBid";
import { requireSession } from "../auth/requireSession";

// No `bidderId` in the Body type: the bidder is derived from the session
// cookie below. A bid is a full-amount, on-session charge, so accepting a
// caller-supplied bidderId — as this route once did — would let anyone bid
// (and charge a card) in anyone else's name.
export function registerPlaceBidRoute(app: FastifyInstance, stripe: Stripe, currency: string): void {
  app.post<{ Body: { amountCents?: number } }>("/bids", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;

    const { amountCents } = request.body ?? {};
    if (typeof amountCents !== "number") {
      reply.code(400);
      return { error: "amountCents is required" };
    }

    const now = new Date();
    const result = await prepareBid({ bidderId: user.id, amountCents, now });
    if (!result.ok) {
      reply.code(422);
      return { error: result.reason };
    }

    // The bid itself is only recorded once this PaymentIntent actually
    // succeeds and the Stripe webhook lands (see stripeWebhook.ts /
    // engine/engine/recordBid) — exactly like the round is re-checked there
    // too, since anything here is just a fast pre-charge sanity check, not
    // the authoritative one.
    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency,
      metadata: { kind: "bid", roundId: result.roundId, bidderId: user.id, amountCents: String(amountCents) },
    });

    return { clientSecret: intent.client_secret };
  });
}
