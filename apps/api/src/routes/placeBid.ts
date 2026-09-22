import type { FastifyInstance } from "fastify";
import { placeBid } from "engine/engine/placeBid";

export function registerPlaceBidRoute(app: FastifyInstance): void {
  app.post<{ Body: { bidderId?: string; amountCents?: number } }>("/bids", async (request, reply) => {
    const { bidderId, amountCents } = request.body ?? {};

    if (!bidderId || typeof bidderId !== "string" || typeof amountCents !== "number") {
      reply.code(400);
      return { error: "bidderId and amountCents are required" };
    }

    const result = await placeBid({ bidderId, amountCents, now: new Date() });
    if (!result.ok) {
      reply.code(422);
      return { error: result.reason };
    }

    return { bidId: result.bidId };
  });
}
