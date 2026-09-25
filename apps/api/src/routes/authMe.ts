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

// Deliberately not restricted to one platform — this can be a link to any
// social network (Instagram, X, TikTok, a personal site, …), or omitted
// entirely. The only real bar is that it's a genuine http(s) URL: an
// unvalidated string ends up in an `href` on the public champion card (see
// Scene.astro), and a scheme like `javascript:` there would execute on
// click.
function isValidSocialUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// Loose on purpose — this is a display label, not an identity, so the only
// real bars are "not empty" and "not absurdly long" (the champion card has
// finite room for it).
const MAX_NAME_LENGTH = 80;

// A free-text description, not a structured field — generous but still
// bounded so a photo upload can't be paired with an unbounded blob.
const MAX_CHARACTER_REQUEST_LENGTH = 500;

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

  // Lets a signed-in user set (or correct) the name shown publicly for them
  // — the champion banner, the scene tooltip, and the leaderboard all render
  // `users.name` (see engine/queries/publicScene.ts's `displayName`).
  // Google/Apple seed it at sign-up, but a user may want something else
  // shown than their real OAuth name.
  app.patch<{ Body: { name?: unknown } }>("/auth/name", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;

    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) {
      reply.code(400);
      return { error: `a name between 1 and ${MAX_NAME_LENGTH} characters is required` };
    }

    await db.update(users).set({ name }).where(eq(users.id, user.id));
    return { id: user.id, name };
  });

  // Optional — lets a signed-in user attach (or, with an empty string,
  // clear) a link to any social network profile, shown alongside their
  // photo once they're the reigning champion. Never required to finish the
  // photo/social step in the frontend flow.
  app.patch<{ Body: { socialUrl?: unknown } }>("/auth/social", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;

    const socialUrl = request.body?.socialUrl;
    if (socialUrl === "") {
      await db.update(users).set({ socialUrl: null }).where(eq(users.id, user.id));
      return { socialUrl: null };
    }
    if (typeof socialUrl !== "string" || !isValidSocialUrl(socialUrl)) {
      reply.code(400);
      return { error: "a valid URL is required" };
    }

    await db.update(users).set({ socialUrl }).where(eq(users.id, user.id));
    return { socialUrl };
  });

  // Optional — captured alongside the photo upload (see POST /auth/photo):
  // a freeform description of how this bidder would like their character
  // rendered in the scene (clothing, style, mood, …). This codebase never
  // parses or acts on it; it's for whoever composes the scene art.
  app.patch<{ Body: { characterRequest?: unknown } }>("/auth/character-request", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;

    const characterRequest = request.body?.characterRequest;
    if (characterRequest === "") {
      await db.update(users).set({ characterRequest: null }).where(eq(users.id, user.id));
      return { characterRequest: null };
    }
    if (typeof characterRequest !== "string" || characterRequest.length > MAX_CHARACTER_REQUEST_LENGTH) {
      reply.code(400);
      return { error: `a description under ${MAX_CHARACTER_REQUEST_LENGTH} characters is required` };
    }

    await db.update(users).set({ characterRequest }).where(eq(users.id, user.id));
    return { characterRequest };
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
