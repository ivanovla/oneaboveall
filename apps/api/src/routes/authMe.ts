import type { FastifyInstance } from "fastify";
import { getUserBySessionToken, deleteSession, SESSION_COOKIE_NAME } from "../auth/session";

export function registerAuthMeRoutes(app: FastifyInstance): void {
  app.get("/auth/me", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    const user = token ? await getUserBySessionToken(token) : null;
    if (!user) {
      reply.code(401);
      return { error: "not signed in" };
    }
    return user;
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (token) {
      await deleteSession(token);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return { loggedOut: true };
  });
}
