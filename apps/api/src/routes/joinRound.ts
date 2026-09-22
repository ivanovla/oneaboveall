import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { getRoundParticipant, getCurrentReign } from "engine/db/repository";
import { calculateDeposit } from "engine/domain/deposit";

export function registerJoinRoundRoute(app: FastifyInstance, stripe: Stripe, currency: string): void {
  app.post<{ Params: { id: string }; Body: { bidderId?: string } }>("/rounds/:id/join", async (request, reply) => {
    const { id: roundId } = request.params;
    const { bidderId } = request.body ?? {};

    if (!bidderId) {
      reply.code(400);
      return { error: "bidderId is required" };
    }

    const existing = await getRoundParticipant(roundId, bidderId);
    if (existing) {
      reply.code(409);
      return { error: "already joined this round" };
    }

    const reign = await getCurrentReign();
    if (!reign) {
      reply.code(404);
      return { error: "no active reign" };
    }

    const depositCents = calculateDeposit(reign.priceCents);

    const intent = await stripe.paymentIntents.create({
      amount: depositCents,
      currency,
      setup_future_usage: "off_session",
      metadata: { roundId, bidderId },
    });

    return { clientSecret: intent.client_secret, depositCents };
  });
}
