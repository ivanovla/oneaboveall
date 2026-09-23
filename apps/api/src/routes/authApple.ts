import type { FastifyInstance } from "fastify";
import { Issuer } from "openid-client";
import { createSession, SESSION_COOKIE_NAME } from "../auth/session";
import {
  OAUTH_STATE_COOKIE_NAME,
  generateState,
  generateCodeVerifier,
  generateCodeChallenge,
} from "../auth/oauthState";
import { generateAppleClientSecret } from "../auth/appleClientSecret";
import { db } from "engine/db/client";
import { users } from "engine/db/schema";
import { and, eq } from "drizzle-orm";

// Same requireEnv pattern as routes/authGoogle.ts (see that file for the
// full rationale): fail at boot on a misconfigured deploy rather than on
// the first real sign-in attempt, and avoid `!` non-null assertions that
// would silently produce a redirect to literal "undefined/account" if a var
// were missing.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

const APPLE_SERVICES_ID = requireEnv("APPLE_SERVICES_ID");
const API_PUBLIC_URL = requireEnv("API_PUBLIC_URL");
const PUBLIC_APP_URL = requireEnv("PUBLIC_APP_URL");

const APPLE_CALLBACK_URL = `${API_PUBLIC_URL}/auth/apple/callback`;

// Same reasoning as authGoogle.ts's SIGN_IN_FAILED_REDIRECT: this endpoint
// is only ever reached via a top-level browser navigation (here, a form
// POST from Apple's consent screen), so every failure branch below
// redirects back into the app instead of dead-ending the user on a bare
// JSON response at the API's own origin. The real cause is still logged
// server-side via request.log.error for debugging.
const SIGN_IN_FAILED_REDIRECT = `${PUBLIC_APP_URL}/?error=sign_in_failed`;

// Same reasoning as Google's cached issuer in authGoogle.ts — Apple's own
// .well-known/openid-configuration doesn't change at runtime either, so
// caching it at module scope avoids a network round-trip on every sign-in.
let appleIssuer: Awaited<ReturnType<typeof Issuer.discover>> | null = null;

async function getAppleClient(clientSecret: string) {
  if (!appleIssuer) {
    appleIssuer = await Issuer.discover("https://appleid.apple.com");
  }
  return new appleIssuer.Client({
    client_id: APPLE_SERVICES_ID,
    client_secret: clientSecret,
    redirect_uris: [APPLE_CALLBACK_URL],
    response_types: ["code"],
  });
}

export function registerAppleAuthRoutes(app: FastifyInstance): void {
  app.get("/auth/apple", async (request, reply) => {
    const clientSecret = await generateAppleClientSecret();
    const client = await getAppleClient(clientSecret);
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // Packed into one cookie value (state + verifier), same as Google's
    // flow — both are needed back at the callback and no user session
    // exists yet to store them against server-side.
    reply.setCookie(OAUTH_STATE_COOKIE_NAME, `${state}.${codeVerifier}`, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });

    const url = client.authorizationUrl({
      scope: "name email",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      // Apple requires form_post when requesting the "name"/"email" scopes:
      // the authorization result (including the one-time "user" JSON blob)
      // is delivered via a POST to the redirect URI instead of a GET query
      // string, which is why the callback route below is a POST handler
      // rather than a GET one like Google's.
      response_mode: "form_post",
    });

    reply.redirect(url);
  });

  app.post<{ Body: { code?: string; state?: string; user?: string } }>(
    "/auth/apple/callback",
    async (request, reply) => {
      // This endpoint is only ever reached via a top-level browser form
      // POST from Apple's consent screen. The state cookie is read here and
      // cleared IMMEDIATELY, before any reply.redirect(...) call below on
      // any path (success or error) — not in a try/finally. reply.redirect
      // calls reply.send() internally, which flushes response headers
      // synchronously, so a clearCookie() issued from a finally block after
      // a redirect has already happened has no effect. See authGoogle.ts's
      // callback for the same fix and the regression it corrects.
      const raw = request.cookies[OAUTH_STATE_COOKIE_NAME];
      reply.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: "/" });

      if (!raw) {
        request.log.error("Apple OAuth callback: missing oauth state cookie");
        reply.redirect(SIGN_IN_FAILED_REDIRECT);
        return;
      }
      const [expectedState, codeVerifier] = raw.split(".");

      // The callback body's "state" is attacker-controlled input reflected
      // from whatever Apple's consent screen (or a forged request) submits.
      // It must be compared against the state this server itself generated
      // and stored in the httpOnly cookie — never trusted on its own. This
      // is the single most security-critical check in this route: see
      // authApple.test.ts's "rejects a mismatched state" test, which
      // deliberately supplies a cookie state that differs from the body
      // state and asserts the token exchange is never reached.
      if (request.body?.state !== expectedState) {
        request.log.error("Apple OAuth callback: state mismatch");
        reply.redirect(SIGN_IN_FAILED_REDIRECT);
        return;
      }

      const clientSecret = await generateAppleClientSecret();
      const client = await getAppleClient(clientSecret);

      let claims: { sub: string };
      try {
        const tokenSet = await client.callback(
          APPLE_CALLBACK_URL,
          { code: request.body?.code, state: request.body?.state },
          { state: expectedState, code_verifier: codeVerifier },
        );
        claims = tokenSet.claims();
      } catch (err) {
        request.log.error({ err }, "Apple OAuth callback failed");
        reply.redirect(SIGN_IN_FAILED_REDIRECT);
        return;
      }

      const [existing] = await db
        .select()
        .from(users)
        .where(and(eq(users.provider, "apple"), eq(users.providerId, claims.sub)))
        .limit(1);

      let user = existing;
      if (!user) {
        // Apple includes this JSON-encoded "user" field, carrying name and
        // email, ONLY on the very first authorization for this app — every
        // later sign-in for the same (provider, providerId) omits it
        // entirely (and Apple's id_token itself never carries a name claim
        // at all). It must be captured now, on creation; it will never be
        // sent again for this user.
        let email = "";
        let name = "";
        if (request.body?.user) {
          try {
            const parsed = JSON.parse(request.body.user) as {
              email?: string;
              name?: { firstName?: string; lastName?: string };
            };
            email = parsed.email ?? "";
            name = [parsed.name?.firstName, parsed.name?.lastName].filter(Boolean).join(" ");
          } catch {
            // Malformed "user" field — proceed with an empty name/email
            // rather than failing the whole sign-in over a non-essential
            // field.
          }
        }
        [user] = await db
          .insert(users)
          .values({ provider: "apple", providerId: claims.sub, email, name })
          .returning();
      }

      const { token, expiresAt } = await createSession(user.id);
      reply.setCookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        expires: expiresAt,
        path: "/",
      });

      reply.redirect(`${PUBLIC_APP_URL}/account`);
    },
  );
}
