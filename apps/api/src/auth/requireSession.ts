import type { FastifyRequest, FastifyReply } from "fastify";
import { getUserBySessionToken, SESSION_COOKIE_NAME } from "./session";

/**
 * Resolves the signed-in user from the session cookie, or rejects the request
 * with a 401 and returns null.
 *
 * Callers do:
 *
 *   const user = await requireSession(request, reply);
 *   if (!user) return;
 *
 * i.e. a single function that performs the whole check, rather than a Fastify
 * `preHandler` hook — this keeps the 401 body identical to every other route's
 * `{ error: string }` shape, and keeps the "is this route authenticated?"
 * answer visible in the handler itself rather than in registration plumbing.
 *
 * The reply is *sent* here (not merely code()'d) so that a caller returning
 * `undefined` afterwards can't accidentally turn the 401 into a 200 with an
 * empty body.
 */
export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ id: string; email: string; name: string } | null> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  const user = token ? await getUserBySessionToken(token) : null;
  if (!user) {
    reply.code(401);
    reply.send({ error: "not signed in" });
    return null;
  }
  return user;
}
