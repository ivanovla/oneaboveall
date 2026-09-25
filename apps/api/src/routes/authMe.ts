import type { FastifyInstance } from "fastify";
import { getUserBySessionToken, deleteSession, SESSION_COOKIE_NAME } from "../auth/session";
import { requireSession } from "../auth/requireSession";
import { db } from "engine/db/client";
import { users } from "engine/db/schema";
import { eq } from "drizzle-orm";

// Deliberately permissive (RFC 5322 is not worth reimplementing here): this
// only guards against an empty string or a value with no "@" at all, the
// same way a browser's own `type="email"` field would. The real bar for "is
// this deliverable" is whether a notification email sent to it bounces,
// which nothing here can check synchronously anyway.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Deliberately narrow to Instagram profile URLs specifically (not "any
// URL") to match what the champion card actually renders as a link label —
// broadening this to arbitrary social links is a real future need, not
// solved here.
const INSTAGRAM_URL_RE = /^https:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.]+\/?$/;

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

  // Lets a signed-in user set or correct the email their account was
  // created with. Google/Apple usually supply one at sign-up, but Apple
  // omits it when the "user" blob is unavailable (see authApple.ts), and a
  // user may simply want a different address for the "you won" notification
  // than the one tied to their OAuth identity.
  app.patch<{ Body: { email?: unknown } }>("/auth/email", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;

    const email = request.body?.email;
    if (typeof email !== "string" || !EMAIL_RE.test(email)) {
      reply.code(400);
      return { error: "a valid email is required" };
    }

    await db.update(users).set({ email }).where(eq(users.id, user.id));
    return { id: user.id, email, name: user.name };
  });

  // Optional — lets a signed-in user attach (or, with an empty string,
  // clear) an Instagram profile link, shown alongside their photo once
  // they're the reigning champion. Never required to finish the
  // photo/social step in the frontend flow.
  app.patch<{ Body: { instagramUrl?: unknown } }>("/auth/social", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;

    const instagramUrl = request.body?.instagramUrl;
    if (instagramUrl === "") {
      await db.update(users).set({ instagramUrl: null }).where(eq(users.id, user.id));
      return { instagramUrl: null };
    }
    if (typeof instagramUrl !== "string" || !INSTAGRAM_URL_RE.test(instagramUrl)) {
      reply.code(400);
      return { error: "a valid Instagram profile URL is required" };
    }

    await db.update(users).set({ instagramUrl }).where(eq(users.id, user.id));
    return { instagramUrl };
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
