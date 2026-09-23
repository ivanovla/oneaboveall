import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { buildServer } from "../src/server";
import { OAUTH_STATE_COOKIE_NAME } from "../src/auth/oauthState";
import { db, pool } from "engine/db/client";
import { users, sessions } from "engine/db/schema";
import { eq } from "drizzle-orm";

function getSetCookieHeader(
  response: { headers: { "set-cookie"?: string | string[] } },
  cookieName: string,
): string | undefined {
  const cookies = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [response.headers["set-cookie"]];
  return cookies.find((c) => c?.startsWith(`${cookieName}=`));
}

vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

const authorizationUrl = vi.fn(() => "https://accounts.google.com/o/oauth2/v2/auth?mock=1");
const callback = vi.fn(async () => ({
  claims: () => ({ sub: "google-sub-1", email: "a@example.com", name: "A Person" }),
}));

vi.mock("openid-client", () => ({
  Issuer: {
    discover: vi.fn(async () => ({
      Client: class {
        authorizationUrl = authorizationUrl;
        callbackParams = vi.fn((req: unknown) => ({ code: "mock-code", state: "mock-state" }));
        callback = callback;
      },
    })),
  },
  generators: {
    state: () => "mock-state",
    codeVerifier: () => "mock-verifier",
    codeChallenge: () => "mock-challenge",
  },
}));

beforeEach(() => {
  authorizationUrl.mockClear();
  callback.mockClear();
});

// This test suite's own DB-backed test creates a `users` row (and, via
// createSession, a `sessions` row referencing it) directly against the real
// test database — unconditional cleanup here (rather than inline at the end
// of that one test) means a failed assertion mid-test still leaves the DB
// clean for the next run, matching the pattern already used in
// tests/auth/session.test.ts.
afterEach(async () => {
  await db.delete(sessions);
  await db.delete(users);
  // Undoes the vi.spyOn(db, ...) the DB-failure test below installs. The
  // module mocks above are plain vi.fn()s, which restoreAllMocks leaves
  // alone.
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool.end();
});

describe("GET /auth/google", () => {
  it("redirects to Google's authorization URL and sets a state cookie", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/auth/google" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://accounts.google.com/o/oauth2/v2/auth?mock=1");
    expect(response.headers["set-cookie"]).toBeDefined();
    const cookies = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [response.headers["set-cookie"]];
    expect(cookies.some((c) => c?.includes("oneabobeall_oauth_state="))).toBe(true);
  });

  // The mirror of authApple.test.ts's "SameSite=None" assertion. The
  // divergence between the two providers is deliberate and load-bearing:
  // Google's callback is a top-level cross-site GET, which a Lax cookie IS
  // sent on, whereas Apple's is a cross-site POST, which it is not. A
  // refactor that "tidied up" the two routes into one shared cookie config
  // would break one provider or the other, and without an assertion on each
  // side nothing would catch it — app.inject bypasses real browser SameSite
  // enforcement entirely.
  it("sets the state cookie with SameSite=Lax (correct for Google's GET callback, unlike Apple's None)", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/auth/google" });

    const stateCookie = getSetCookieHeader(response, OAUTH_STATE_COOKIE_NAME);
    expect(stateCookie).toMatch(/SameSite=Lax/i);
    expect(stateCookie).not.toMatch(/SameSite=None/i);
    expect(stateCookie).toMatch(/Secure/i);
    expect(stateCookie).toMatch(/HttpOnly/i);
  });

  // The entry point is reached by a top-level browser navigation, same as the
  // callback, so a failure while building the authorization URL (the cached
  // Issuer.discover() network fetch, most realistically) has to land the user
  // back in the app rather than on a raw 500 at the API's own origin.
  it("redirects to the app when building the authorization request throws, instead of 500ing", async () => {
    authorizationUrl.mockImplementationOnce(() => {
      throw new Error("getaddrinfo ENOTFOUND accounts.google.com");
    });

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/auth/google" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${process.env.PUBLIC_APP_URL}/?error=sign_in_failed`);
  });
});

describe("GET /auth/google/callback", () => {
  it("redirects to the app with an error when the state cookie is missing, without exchanging any code", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/auth/google/callback?code=x&state=y" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${process.env.PUBLIC_APP_URL}/?error=sign_in_failed`);
    expect(callback).not.toHaveBeenCalled();
    // Cleared here too (not just on the happier paths below) — the state
    // cookie is single-use regardless of outcome, and a request reaching
    // this branch has already been read for its raw value by the time the
    // clear happens.
    expect(getSetCookieHeader(response, OAUTH_STATE_COOKIE_NAME)).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  // The mocked `callbackParams` above always returns a fixed
  // `{ code: "mock-code", state: "mock-state" }` regardless of the actual
  // request — so this test can't exercise a mismatch by varying the request
  // URL's `state` query param. Instead it injects a state cookie whose
  // packed state ("wrong-state") differs from what callbackParams will
  // report ("mock-state"), which is exactly the case the state check exists
  // to catch: a cookie that doesn't match the state Google is echoing back.
  //
  // This is the single most security-critical branch in the whole route —
  // without this test, deleting the `if (params.state !== expectedState)`
  // guard from authGoogle.ts leaves every other test in this file green,
  // since none of them otherwise distinguish a checked state from an
  // unchecked one.
  it("rejects a mismatched state with a redirect and never exchanges the code", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "GET",
      url: "/auth/google/callback?code=mock-code&state=mock-state",
      headers: { cookie: "oneabobeall_oauth_state=wrong-state.mock-verifier" },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${process.env.PUBLIC_APP_URL}/?error=sign_in_failed`);
    // The real security property: state mismatch must stop the flow before
    // any token exchange is attempted, not just before a session is issued.
    expect(callback).not.toHaveBeenCalled();
    // The single-use state cookie must actually be cleared on this error
    // path, not just left to expire on its own 600s maxAge. A prior version
    // of the handler cleared it in a try/finally wrapping the whole body,
    // which silently did nothing on every path (reply.redirect() already
    // flushes the response headers before a `finally` block runs) — this
    // assertion is what would have caught that regression.
    expect(getSetCookieHeader(response, OAUTH_STATE_COOKIE_NAME)).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it("creates a new user, a session, sets the session cookie, and redirects to the app", async () => {
    const app = buildServer();
    const stateResponse = await app.inject({ method: "GET", url: "/auth/google" });
    const stateCookie = (Array.isArray(stateResponse.headers["set-cookie"]) ? stateResponse.headers["set-cookie"] : [stateResponse.headers["set-cookie"]])
      .find((c) => c?.includes("oneabobeall_oauth_state="))!;

    const response = await app.inject({
      method: "GET",
      url: "/auth/google/callback?code=mock-code&state=mock-state",
      headers: { cookie: stateCookie.split(";")[0] },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(process.env.PUBLIC_APP_URL + "/account");
    const cookies = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [response.headers["set-cookie"]];
    expect(cookies.some((c) => c?.includes("oneabobeall_session="))).toBe(true);

    // Locks in that the PKCE code_verifier generated at /auth/google was
    // actually threaded through to the token exchange, not just generated
    // and discarded — this is a real assertion on the exchange call's
    // arguments, not just code inspection.
    expect(callback).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      state: "mock-state",
      code_verifier: "mock-verifier",
    });

    const [user] = await db.select().from(users).where(eq(users.provider, "google"));
    expect(user.email).toBe("a@example.com");
    expect(user.providerId).toBe("google-sub-1");

    // The state cookie must be cleared on the success path too, not just on
    // errors — it's single-use, and a stale one lingering for its full
    // 600s maxAge after a successful sign-in serves no purpose.
    expect(getSetCookieHeader(response, OAUTH_STATE_COOKIE_NAME)).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  // The token exchange has always been wrapped; the user lookup/insert and
  // createSession that follow it were not, so a transient DB error or a
  // unique-constraint race between two concurrent first-time callbacks
  // raw-500'd at the API's own origin instead of redirecting the user back
  // into the app. Mirrors the equivalent try/catch in authApple.ts.
  it("redirects to the app when the user/session creation fails, instead of 500ing", async () => {
    const selectSpy = vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("connection terminated unexpectedly");
    });

    const app = buildServer();
    const stateResponse = await app.inject({ method: "GET", url: "/auth/google" });
    const stateCookie = (Array.isArray(stateResponse.headers["set-cookie"]) ? stateResponse.headers["set-cookie"] : [stateResponse.headers["set-cookie"]])
      .find((c) => c?.includes("oneabobeall_oauth_state="))!;

    const response = await app.inject({
      method: "GET",
      url: "/auth/google/callback?code=mock-code&state=mock-state",
      headers: { cookie: stateCookie.split(";")[0] },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${process.env.PUBLIC_APP_URL}/?error=sign_in_failed`);
    // The failure really did happen in the DB block, i.e. after a successful
    // token exchange — not somewhere earlier that would redirect anyway.
    expect(callback).toHaveBeenCalled();
    expect(selectSpy).toHaveBeenCalled();
    // No session cookie handed out on a failed sign-in.
    const cookies = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [response.headers["set-cookie"]];
    expect(cookies.some((c) => c?.includes("oneabobeall_session="))).toBe(false);
  });
});
