import type { FastifyInstance } from "fastify";
import { getQueueLeader } from "engine/db/repository";
import { requireSession } from "../auth/requireSession";

// rounds.id is a Postgres `uuid` column, so querying it with a value that
// isn't UUID-shaped doesn't return "no rows" — it raises `invalid input syntax
// for type uuid` and surfaces as a 500 with a database error in the logs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerRoundParticipationRoute(app: FastifyInstance): void {
  // "Am *I* the current leader of this round?" — the frontend uses this to
  // disable Displace for a user who's already leading (a fresh bid must
  // outbid someone else first; you can't raise your own standing bid). The
  // bidder id is never taken from the URL or the query string, so this
  // cannot be turned into a probe for who else is leading.
  app.get<{ Params: { id: string } }>("/rounds/:id/me", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;

    const roundId = request.params.id;
    if (!UUID_RE.test(roundId)) {
      reply.code(400);
      return { error: "invalid round id" };
    }

    const leader = await getQueueLeader(roundId);
    return { isLeading: leader?.bidderId === user.id };
  });
}
