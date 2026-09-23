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
import secureJson from "secure-json-parse";

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
    //
    // sameSite MUST be "none" here, unlike Google's "lax" — Apple's
    // callback arrives as a cross-site POST (appleid.apple.com ->
    // API_PUBLIC_URL, via response_mode: "form_post"), and a Lax cookie is
    // only sent on cross-site top-level *GET* navigations, never on a
    // cross-site POST. With "lax" here, this cookie would simply never
    // arrive at POST /auth/apple/callback in production, and every real
    // sign-in would hit the "missing state cookie" branch. "none" requires
    // `secure: true` (already set), which the browser enforces.
    reply.setCookie(OAUTH_STATE_COOKIE_NAME, `${state}.${codeVerifier}`, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
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

      let claims: { sub: string; email?: string };
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

      // Everything below (the user lookup/insert and session creation) can
      // fail independently of the token exchange above — a DB error, or a
      // unique-constraint violation from two concurrent first-time
      // callbacks racing for the same (provider, providerId) — and must
      // still land the user back in the app rather than a raw 500, same as
      // every other failure branch in this handler.
      try {
        const [existing] = await db
          .select()
          .from(users)
          .where(and(eq(users.provider, "apple"), eq(users.providerId, claims.sub)))
          .limit(1);

        let user = existing;
        if (!user) {
          // Apple includes this JSON-encoded "user" field, carrying name
          // and email, ONLY on the very first authorization for this app —
          // every later sign-in for the same (provider, providerId) omits
          // it entirely. It must be captured now, on creation; it will
          // never be sent again for this user.
          //
          // Email is preferred from `claims.email` — a claim on Apple's
          // cryptographically-signed id_token, present whenever the
          // "email" scope was granted, including on returning users — over
          // the unsigned "user" JSON blob's email, which Apple explicitly
          // documents as a plain form field with no signature: a malicious
          // client completing a legitimate sign-in could submit a forged
          // value there. The blob is only the fallback, and only "name" is
          // ever taken from it, since Apple's id_token has no name claim at
          // all — there is no verified source for it.
          let unsignedEmail: string | undefined;
          let name = "";
          if (request.body?.user) {
            try {
              const parsed = secureJson.parse(request.body.user, null, {
                protoAction: "error",
                constructorAction: "error",
              }) as { email?: string; name?: { firstName?: string; lastName?: string } };
              unsignedEmail = parsed.email;
              name = [parsed.name?.firstName, parsed.name?.lastName].filter(Boolean).join(" ");
            } catch {
              // Malformed "user" field — proceed with an empty name rather
              // than failing the whole sign-in over a non-essential field.
            }
          }
          const email = claims.email ?? unsignedEmail ?? "";
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
      } catch (err) {
        request.log.error({ err }, "Apple OAuth callback: user/session creation failed");
        reply.redirect(SIGN_IN_FAILED_REDIRECT);
      }
    },
  );
}
