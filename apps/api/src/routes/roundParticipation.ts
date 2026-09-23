import type { FastifyInstance } from "fastify";
import { getRoundParticipant } from "engine/db/repository";
import { requireSession } from "../auth/requireSession";

// rounds.id is a Postgres `uuid` column, so querying it with a value that
// isn't UUID-shaped doesn't return "no rows" — it raises `invalid input syntax
// for type uuid` and surfaces as a 500 with a database error in the logs. The
// sibling route POST /rounds/:id/join never has this problem because it
// compares `:id` against the current round as a plain string before using it
// in a query; this route queries with it directly, so it has to check the
// shape itself.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    const roundId = request.params.id;
    if (!UUID_RE.test(roundId)) {
      reply.code(400);
      return { error: "invalid round id" };
    }

    const participant = await getRoundParticipant(roundId, user.id);
    return { joined: !!participant };
  });
}
