import type { FastifyInstance } from "fastify";
import { Issuer } from "openid-client";
import { createSession, SESSION_COOKIE_NAME } from "../auth/session";
import { OAUTH_STATE_COOKIE_NAME, generateState, generateCodeVerifier, generateCodeChallenge } from "../auth/oauthState";
import { db } from "engine/db/client";
import { users } from "engine/db/schema";
import { and, eq } from "drizzle-orm";

// Issuer.discover() fetches Google's .well-known/openid-configuration over
// the network — this config doesn't change at runtime, so caching it at
// module scope avoids an extra network round-trip on every single sign-in
// attempt (both server load and the signing-in user's own latency).
// Constructing a Client from the cached issuer is a cheap, synchronous,
// no-network operation, so that part stays uncached/per-call.
let googleIssuer: Awaited<ReturnType<typeof Issuer.discover>> | null = null;

async function getGoogleClient() {
  if (!googleIssuer) {
    googleIssuer = await Issuer.discover("https://accounts.google.com");
  }
  return new googleIssuer.Client({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    redirect_uris: [`${process.env.API_PUBLIC_URL}/auth/google/callback`],
    response_types: ["code"],
  });
}

export function registerGoogleAuthRoutes(app: FastifyInstance): void {
  app.get("/auth/google", async (request, reply) => {
    const client = await getGoogleClient();
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // Packed into one cookie value (state + verifier) since both are needed
    // back at the callback and no user session exists yet to store them
    // server-side against. Short-lived and httpOnly — this cookie carries no
    // user data, just the handshake's own nonces.
    reply.setCookie(OAUTH_STATE_COOKIE_NAME, `${state}.${codeVerifier}`, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });

    const url = client.authorizationUrl({
      scope: "openid email profile",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    reply.redirect(url);
  });

  app.get("/auth/google/callback", async (request, reply) => {
    const raw = request.cookies[OAUTH_STATE_COOKIE_NAME];
    if (!raw) {
      reply.code(400);
      return { error: "missing oauth state cookie" };
    }
    const [expectedState, codeVerifier] = raw.split(".");

    const client = await getGoogleClient();
    const params = client.callbackParams(request.raw);

    if (params.state !== expectedState) {
      reply.code(400);
      return { error: "state mismatch" };
    }

    let claims: { sub: string; email?: string; name?: string };
    try {
      const tokenSet = await client.callback(
        `${process.env.API_PUBLIC_URL}/auth/google/callback`,
        params,
        { state: expectedState, code_verifier: codeVerifier },
      );
      claims = tokenSet.claims();
    } catch (err) {
      request.log.error({ err }, "Google OAuth callback failed");
      reply.code(400);
      return { error: "sign-in failed" };
    }

    const [existing] = await db
      .select()
      .from(users)
      .where(and(eq(users.provider, "google"), eq(users.providerId, claims.sub)))
      .limit(1);

    const user =
      existing ??
      (
        await db
          .insert(users)
          .values({
            provider: "google",
            providerId: claims.sub,
            email: claims.email ?? "",
            name: claims.name ?? "",
          })
          .returning()
      )[0];

    const { token, expiresAt } = await createSession(user.id);
    reply.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: "/" });
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      expires: expiresAt,
      path: "/",
    });

    reply.redirect(`${process.env.PUBLIC_APP_URL}/account`);
  });
}
