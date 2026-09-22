import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { getRoundParticipant, getCurrentReign, getLatestRound, isBanned } from "engine/db/repository";
import { isBiddingOpen } from "engine/engine/joinRound";
import { calculateDeposit } from "engine/domain/deposit";

export function registerJoinRoundRoute(app: FastifyInstance, stripe: Stripe, currency: string): void {
  app.post<{ Params: { id: string }; Body: { bidderId?: string } }>("/rounds/:id/join", async (request, reply) => {
    const { id: roundId } = request.params;
    const { bidderId } = request.body ?? {};

    if (!bidderId || typeof bidderId !== "string") {
      reply.code(400);
      return { error: "bidderId is required" };
    }

    const reign = await getCurrentReign();
    if (!reign) {
      reply.code(404);
      return { error: "no active reign" };
    }

    // The `:id` in the URL is caller-supplied and untrusted — verify it's
    // genuinely the current round (derived server-side from the current
    // reign) before doing anything else. Without this check, a caller could
    // vary `:id` between calls to defeat the duplicate-join guard below, or
    // target a round that doesn't exist at all and only find out after a
    // PaymentIntent has already been created.
    const round = await getLatestRound(reign.id);
    if (!round || round.id !== roundId) {
      reply.code(404);
      return { error: "round not found or no longer current" };
    }

    // Charging a deposit for a round that is no longer open to joins would
    // make engine joinRound's race-refund path the *normal* path: every click
    // on a page left open past the window would be charged and immediately
    // refunded. That check lives in the engine (it is the authoritative one,
    // re-evaluated after the webhook arrives); this is the same test applied
    // early so no money moves in the common case.
    const now = new Date();
    if (!isBiddingOpen(round, now)) {
      reply.code(409);
      return { error: "round is not open for joining" };
    }

    // A banned bidder can pay a deposit and join today, but placeBid rejects
    // every bid they attempt — their money would just sit charged until the
    // round closes and refunds it. Refuse before taking it.
    if (await isBanned(bidderId, now)) {
      reply.code(403);
      return { error: "bidder is banned" };
    }

    const existing = await getRoundParticipant(round.id, bidderId);
    if (existing) {
      reply.code(409);
      return { error: "already joined this round" };
    }

    const depositCents = calculateDeposit(reign.priceCents);

    // Stripe only allows a saved PaymentMethod to be reused in a later,
    // separate PaymentIntent (the off-session remainder charge) when that
    // method is attached to a Customer and both intents name it. Creating one
    // here — and passing it below — is what makes setup_future_usage actually
    // usable later.
    //
    // A fresh Customer per join is deliberate: there is no persistent
    // bidder→customer mapping in this codebase, and building one is out of
    // scope. The cost is extra Stripe Customer objects, not money at risk.
    const customer = await stripe.customers.create({ metadata: { bidderId } });

    const intent = await stripe.paymentIntents.create({
      amount: depositCents,
      currency,
      customer: customer.id,
      setup_future_usage: "off_session",
      // `kind` marks this explicitly as a deposit. The webhook used to infer
      // that from the mere presence of roundId/bidderId, which would misread
      // any future PaymentIntent that happened to carry similar metadata.
      metadata: { kind: "deposit", roundId: round.id, bidderId },
    });

    return { clientSecret: intent.client_secret, depositCents };
  });
}
