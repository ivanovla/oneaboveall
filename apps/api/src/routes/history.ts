import type { FastifyInstance } from "fastify";
import { getBidderHistory } from "engine/db/repository";
import { requireSession } from "../auth/requireSession";

// The signed-in user's own activity across every round they've ever bid in
// — a personal history, never another bidder's. Always derived from the
// session, the same way placeBid.ts derives bidderId, never from a request
// param.
export function registerHistoryRoute(app: FastifyInstance): void {
  app.get("/me/history", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;

    const history = await getBidderHistory(user.id);
    return { history };
  });
}
