import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { getRoundParticipant, getCurrentReign, getLatestRound } from "engine/db/repository";
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

    const existing = await getRoundParticipant(round.id, bidderId);
    if (existing) {
      reply.code(409);
      return { error: "already joined this round" };
    }

    const depositCents = calculateDeposit(reign.priceCents);

    const intent = await stripe.paymentIntents.create({
      amount: depositCents,
      currency,
      setup_future_usage: "off_session",
      metadata: { roundId: round.id, bidderId },
    });

    return { clientSecret: intent.client_secret, depositCents };
  });
}
