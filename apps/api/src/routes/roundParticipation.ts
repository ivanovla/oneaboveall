import type { FastifyInstance } from "fastify";
import { getRoundParticipant } from "engine/db/repository";
import { requireSession } from "../auth/requireSession";

export function registerRoundParticipationRoute(app: FastifyInstance): void {
  // "Have *I* joined this round?" — the answer is always about the session
  // user. The bidder id is never taken from the URL or the query string, so
  // this cannot be turned into a probe for whether some other bidder has
  // joined. The round id is caller-supplied, but a bidder's own join status
  // for an arbitrary round is not sensitive: for a round they never joined the
  // answer is simply false.
  app.get<{ Params: { id: string } }>("/rounds/:id/me", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;

    const participant = await getRoundParticipant(request.params.id, user.id);
    return { joined: !!participant };
  });
}
