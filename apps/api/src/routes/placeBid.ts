import type { FastifyInstance } from "fastify";
import { placeBid } from "engine/engine/placeBid";
import { requireSession } from "../auth/requireSession";

export function registerPlaceBidRoute(app: FastifyInstance): void {
  // No `bidderId` in the Body type: the bidder is derived from the session
  // cookie below. A bid commits its owner to paying the remainder off-session
  // if it wins, so accepting a caller-supplied bidderId — as this route once
  // did — let anyone bid in anyone else's name.
  app.post<{ Body: { amountCents?: number } }>("/bids", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;

    const { amountCents } = request.body ?? {};
    if (typeof amountCents !== "number") {
      reply.code(400);
      return { error: "amountCents is required" };
    }

    const result = await placeBid({ bidderId: user.id, amountCents, now: new Date() });
    if (!result.ok) {
      reply.code(422);
      return { error: result.reason };
    }

    return { bidId: result.bidId };
  });
}
