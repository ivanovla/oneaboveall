import type { FastifyInstance } from "fastify";
import { Issuer } from "openid-client";
import { createSession, SESSION_COOKIE_NAME } from "../auth/session";
import { OAUTH_STATE_COOKIE_NAME, generateState, generateCodeVerifier, generateCodeChallenge } from "../auth/oauthState";
import { db } from "engine/db/client";
import { users } from "engine/db/schema";
import { and, eq } from "drizzle-orm";

// Validated at module load, the same way stripeClient.ts validates
// STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET and server.ts validates
// CORS_ORIGIN: fail the process at boot on a misconfigured deploy rather
// than on the first real sign-in attempt. Without this, a missing
// PUBLIC_APP_URL in particular would silently produce
// `reply.redirect("undefined/account")` on an otherwise-successful sign-in,
// with no error surfaced anywhere.
//
// Returns the env var narrowed to `string`, not `string | undefined` — a
// plain `if (!process.env.X) throw ...` guard next to a separately-declared
// `const` doesn't narrow that const's type inside functions defined later
// in this module (TypeScript's control-flow analysis doesn't cross function
// boundaries), which is what pushed the original code toward `!`
// non-null-assertions at every call site instead.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

const GOOGLE_CLIENT_ID = requireEnv("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = requireEnv("GOOGLE_CLIENT_SECRET");
const API_PUBLIC_URL = requireEnv("API_PUBLIC_URL");
const PUBLIC_APP_URL = requireEnv("PUBLIC_APP_URL");

const GOOGLE_CALLBACK_URL = `${API_PUBLIC_URL}/auth/google/callback`;

// Reached only via a top-level browser navigation from Google's consent
// screen — a user who lands here (state cookie expired after too long on
// Google's screen, a tampered/replayed callback, or a genuine provider
// error) has no way back to the app from a bare JSON error response at the
// API's own origin. Redirecting keeps them inside the app; there's no
// dedicated error page yet, so this lands on the app root with a query
// flag it can choose to surface later.
const SIGN_IN_FAILED_REDIRECT = `${PUBLIC_APP_URL}/?error=sign_in_failed`;

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
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uris: [GOOGLE_CALLBACK_URL],
    response_types: ["code"],
  });
}

export function registerGoogleAuthRoutes(app: FastifyInstance): void {
  app.get("/auth/google", async (request, reply) => {
    // The entry point needs the same redirect-on-failure treatment as the
    // callback below, for the same reason: it is reached by a top-level
    // browser navigation (the user clicking "Sign in with Google"), so a raw
    // 500 strands them on a bare JSON error at the API's own origin with no
    // way back. getGoogleClient() does a live Issuer.discover() network fetch
    // on the first call after boot, and a transient DNS/network failure there
    // is an entirely ordinary thing to hit.
    try {
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
    } catch (err) {
      request.log.error({ err }, "Google OAuth authorization request failed");
      reply.redirect(SIGN_IN_FAILED_REDIRECT);
    }
  });

  app.get("/auth/google/callback", async (request, reply) => {
    // This endpoint is only ever reached via a top-level browser navigation
    // from Google's consent screen, so every failure branch below redirects
    // back into the app instead of dead-ending the user on a bare JSON
    // response at the API's own origin (e.g. taking more than the state
    // cookie's 600s maxAge on Google's consent screen is a real,
    // non-adversarial way to hit the first branch). The real cause is still
    // logged server-side via request.log.error for debugging.
    const raw = request.cookies[OAUTH_STATE_COOKIE_NAME];

    // Cleared here, immediately after reading it and before any
    // reply.redirect(...) call below (success or error) — it's single-use
    // regardless of outcome, so there's no reason to leave a stale one
    // sitting in the browser after this point. This must happen before any
    // redirect: reply.redirect(...) calls reply.send() internally, which
    // writes the response headers synchronously, so a clearCookie() issued
    // afterwards (e.g. from a try/finally wrapping the redirect) has no
    // effect — the headers have already been flushed. An earlier version of
    // this handler cleared it in a `finally` block after the redirect calls
    // and silently failed to clear the cookie on every path as a result.
    reply.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: "/" });

    if (!raw) {
      request.log.error("Google OAuth callback: missing oauth state cookie");
      reply.redirect(SIGN_IN_FAILED_REDIRECT);
      return;
    }
    const [expectedState, codeVerifier] = raw.split(".");

    // Guarded for the same reason as GET /auth/google above:
    // getGoogleClient() may do a live Issuer.discover() fetch on the first
    // call after boot, which can fail for reasons unrelated to this request.
    let client: Awaited<ReturnType<typeof getGoogleClient>>;
    let params: ReturnType<typeof client.callbackParams>;
    try {
      client = await getGoogleClient();
      params = client.callbackParams(request.raw);
    } catch (err) {
      request.log.error({ err }, "Google OAuth callback: client setup failed");
      reply.redirect(SIGN_IN_FAILED_REDIRECT);
      return;
    }

    if (params.state !== expectedState) {
      request.log.error("Google OAuth callback: state mismatch");
      reply.redirect(SIGN_IN_FAILED_REDIRECT);
      return;
    }

    let claims: { sub: string; email?: string; name?: string };
    try {
      const tokenSet = await client.callback(GOOGLE_CALLBACK_URL, params, {
        state: expectedState,
        code_verifier: codeVerifier,
      });
      claims = tokenSet.claims();
    } catch (err) {
      request.log.error({ err }, "Google OAuth callback failed");
      reply.redirect(SIGN_IN_FAILED_REDIRECT);
      return;
    }

    // Everything below (the user lookup/insert and session creation) can fail
    // independently of the token exchange above — a transient DB error, or a
    // unique-constraint violation from two concurrent first-time callbacks
    // racing for the same (provider, providerId) — and must still land the
    // user back in the app rather than a raw 500, same as every other failure
    // branch in this handler. Mirrors authApple.ts's equivalent block.
    try {
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
      reply.setCookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        expires: expiresAt,
        path: "/",
      });

      // `?welcome=1` only on the account's very first sign-in (the `existing`
      // lookup above came back empty) — AccountShell uses it to show a
      // one-time "confirm your email" prompt right after signup, never on a
      // later, ordinary sign-in.
      const isNewUser = !existing;
      reply.redirect(`${PUBLIC_APP_URL}/account${isNewUser ? "?welcome=1" : ""}`);
    } catch (err) {
      request.log.error({ err }, "Google OAuth callback: user/session creation failed");
      reply.redirect(SIGN_IN_FAILED_REDIRECT);
    }
  });
}
