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

const callback = vi.fn(async () => ({
  claims: () => ({ sub: "apple-sub-1" }),
}));

vi.mock("openid-client", () => ({
  Issuer: {
    discover: vi.fn(async () => ({
      Client: class {
        authorizationUrl = vi.fn(() => "https://appleid.apple.com/auth/authorize?mock=1");
        callbackParams = vi.fn(() => ({ code: "mock-code", state: "mock-state" }));
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

vi.mock("../src/auth/appleClientSecret", () => ({
  generateAppleClientSecret: vi.fn(async () => "mock.jwt.secret"),
}));

beforeEach(() => {
  callback.mockClear();
});

// Cleanup lives in afterEach/afterAll (not inline at the end of each test)
// so a failed assertion earlier in a test still leaves the shared test DB
// clean for the next test/file — matches the pattern in
// tests/auth/session.test.ts and tests/authGoogle.test.ts. An inline
// `await db.delete(...)` placed after assertions never runs if one of those
// assertions throws.
afterEach(async () => {
  await db.delete(sessions);
  await db.delete(users);
});

afterAll(async () => {
  await pool.end();
});

describe("GET /auth/apple", () => {
  it("redirects to Apple's authorization URL and sets a state cookie", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/auth/apple" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://appleid.apple.com/auth/authorize?mock=1");
    const cookies = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [response.headers["set-cookie"]];
    expect(cookies.some((c) => c?.includes("oneabobeall_oauth_state="))).toBe(true);
  });

  // Unlike Google's state cookie (SameSite=Lax, correct for its GET-based
  // callback), Apple's callback is a cross-site POST from
  // appleid.apple.com, which a Lax cookie is never sent on. This locks in
  // that the state cookie actually carries SameSite=None (with Secure,
  // required by browsers for None) rather than silently regressing back to
  // Lax — a mistake that `app.inject`'s cookie-header injection in the
  // other tests below would NOT catch on its own, since inject bypasses
  // real browser SameSite enforcement entirely.
  it("sets the state cookie with SameSite=None so it survives Apple's cross-site POST callback", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/auth/apple" });

    const stateCookie = getSetCookieHeader(response, OAUTH_STATE_COOKIE_NAME);
    expect(stateCookie).toMatch(/SameSite=None/i);
    expect(stateCookie).toMatch(/Secure/i);
  });

  // The callback carefully redirects on every failure; the entry point did
  // not. generateAppleClientSecret() readFileSync's APPLE_PRIVATE_KEY_PATH,
  // so a missing or misconfigured .p8 threw ENOENT straight out of the
  // handler as a raw 500 at the API's own origin — with the user having just
  // clicked "Sign in with Apple" and no way back into the app.
  it("redirects to the app when client-secret generation fails (e.g. a missing .p8), instead of 500ing", async () => {
    const { generateAppleClientSecret } = await import("../src/auth/appleClientSecret");
    vi.mocked(generateAppleClientSecret).mockRejectedValueOnce(
      new Error("ENOENT: no such file or directory, open './apple-private-key.p8'"),
    );

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/auth/apple" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${process.env.PUBLIC_APP_URL}/?error=sign_in_failed`);
  });
});

describe("POST /auth/apple/callback", () => {
  // Apple's callback is a POST reached only via a top-level form submit
  // from Apple's own consent screen, so a missing state cookie (session
  // storage cleared, cookie expired past its 600s maxAge, or a forged
  // direct POST) should land the user back in the app with a visible error
  // flag rather than stranding them on a bare JSON response at the API's
  // own origin — same behavior as authGoogle.ts's callback.
  it("redirects to the app with an error when the state cookie is missing, without exchanging any code", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/auth/apple/callback", payload: { code: "x", state: "y" } });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${process.env.PUBLIC_APP_URL}/?error=sign_in_failed`);
    expect(callback).not.toHaveBeenCalled();
    expect(getSetCookieHeader(response, OAUTH_STATE_COOKIE_NAME)).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  // The mocked `callback` above always succeeds when called with any
  // arguments, so the only thing standing between an attacker-supplied
  // "state" and a completed sign-in is the `request.body?.state !==
  // expectedState` check itself. This test injects a state cookie
  // ("wrong-state") that differs from the state submitted in the callback
  // body ("mock-state") — exactly the mismatch the check exists to catch —
  // and asserts client.callback is never reached. Without this test,
  // deleting that guard from authApple.ts would leave every other test in
  // this file green.
  it("rejects a mismatched state with a redirect and never exchanges the code", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/auth/apple/callback",
      headers: { cookie: "oneabobeall_oauth_state=wrong-state.mock-verifier" },
      payload: { code: "mock-code", state: "mock-state" },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${process.env.PUBLIC_APP_URL}/?error=sign_in_failed`);
    expect(callback).not.toHaveBeenCalled();
    expect(getSetCookieHeader(response, OAUTH_STATE_COOKIE_NAME)).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it("redirects to the app with an error when the token exchange fails", async () => {
    callback.mockImplementationOnce(async () => {
      throw new Error("invalid_grant");
    });

    const app = buildServer();
    const stateResponse = await app.inject({ method: "GET", url: "/auth/apple" });
    const stateCookie = (Array.isArray(stateResponse.headers["set-cookie"]) ? stateResponse.headers["set-cookie"] : [stateResponse.headers["set-cookie"]])
      .find((c) => c?.includes("oneabobeall_oauth_state="))!;

    const response = await app.inject({
      method: "POST",
      url: "/auth/apple/callback",
      headers: { cookie: stateCookie.split(";")[0] },
      payload: { code: "mock-code", state: "mock-state" },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${process.env.PUBLIC_APP_URL}/?error=sign_in_failed`);
    expect(getSetCookieHeader(response, OAUTH_STATE_COOKIE_NAME)).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it("creates a new user from user data present only on first authorization, sets a session, and redirects", async () => {
    const app = buildServer();
    const stateResponse = await app.inject({ method: "GET", url: "/auth/apple" });
    const stateCookie = (Array.isArray(stateResponse.headers["set-cookie"]) ? stateResponse.headers["set-cookie"] : [stateResponse.headers["set-cookie"]])
      .find((c) => c?.includes("oneabobeall_oauth_state="))!;

    const response = await app.inject({
      method: "POST",
      url: "/auth/apple/callback",
      headers: { cookie: stateCookie.split(";")[0] },
      payload: {
        code: "mock-code",
        state: "mock-state",
        // Apple sends this JSON-encoded-string "user" field only on the
        // FIRST authorization for a given app; it carries the name, since
        // Apple's id_token itself never carries a name claim at all.
        user: JSON.stringify({ name: { firstName: "A", lastName: "Person" }, email: "a@privaterelay.appleid.com" }),
      },
    });

    expect(response.statusCode).toBe(302);
    // ?welcome=1 only on this account's very first sign-in — AccountShell
    // uses it to show a one-time "confirm your email" prompt.
    expect(response.headers.location).toBe(process.env.PUBLIC_APP_URL + "/account?welcome=1");
    const cookies = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [response.headers["set-cookie"]];
    expect(cookies.some((c) => c?.includes("oneabobeall_session="))).toBe(true);
    expect(getSetCookieHeader(response, OAUTH_STATE_COOKIE_NAME)).toMatch(/Expires=Thu, 01 Jan 1970/);

    const [user] = await db.select().from(users).where(eq(users.provider, "apple"));
    expect(user.providerId).toBe("apple-sub-1");
    expect(user.name).toBe("A Person");
    expect(user.email).toBe("a@privaterelay.appleid.com");
  });

  // Apple's response_mode: "form_post" callback arrives as a real
  // application/x-www-form-urlencoded POST body, not JSON — every other
  // test in this file uses `payload: {...}` with inject's default JSON
  // encoding, which would pass even if the server had no
  // application/x-www-form-urlencoded parser registered at all (the exact
  // gap that made real Apple sign-in 415 before this fix). This test sends
  // a real urlencoded body with an explicit Content-Type, exercising the
  // actual @fastify/formbody registration in server.ts end to end.
  it("parses a real application/x-www-form-urlencoded callback body (Apple's actual wire format)", async () => {
    const app = buildServer();
    const stateResponse = await app.inject({ method: "GET", url: "/auth/apple" });
    const stateCookie = (Array.isArray(stateResponse.headers["set-cookie"]) ? stateResponse.headers["set-cookie"] : [stateResponse.headers["set-cookie"]])
      .find((c) => c?.includes("oneabobeall_oauth_state="))!;

    const body = new URLSearchParams({
      code: "mock-code",
      state: "mock-state",
      user: JSON.stringify({ name: { firstName: "A", lastName: "Person" }, email: "a@privaterelay.appleid.com" }),
    }).toString();

    const response = await app.inject({
      method: "POST",
      url: "/auth/apple/callback",
      headers: {
        cookie: stateCookie.split(";")[0],
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: body,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(process.env.PUBLIC_APP_URL + "/account?welcome=1");
    expect(callback).toHaveBeenCalled();

    const [user] = await db.select().from(users).where(eq(users.provider, "apple"));
    expect(user.providerId).toBe("apple-sub-1");
    expect(user.name).toBe("A Person");
  });

  // The unsigned "user" JSON blob is a plain form field Apple does not
  // cryptographically verify — a client completing a legitimate sign-in
  // could submit a forged email there. The verified id_token's "email"
  // claim must win whenever both are present.
  it("prefers the signed id_token's email claim over the unsigned 'user' blob's email", async () => {
    callback.mockImplementationOnce(async () => ({
      claims: () => ({ sub: "apple-sub-1", email: "verified@example.com" }),
    }));

    const app = buildServer();
    const stateResponse = await app.inject({ method: "GET", url: "/auth/apple" });
    const stateCookie = (Array.isArray(stateResponse.headers["set-cookie"]) ? stateResponse.headers["set-cookie"] : [stateResponse.headers["set-cookie"]])
      .find((c) => c?.includes("oneabobeall_oauth_state="))!;

    const response = await app.inject({
      method: "POST",
      url: "/auth/apple/callback",
      headers: { cookie: stateCookie.split(";")[0] },
      payload: {
        code: "mock-code",
        state: "mock-state",
        user: JSON.stringify({ name: { firstName: "A", lastName: "Person" }, email: "forged@attacker.example" }),
      },
    });

    expect(response.statusCode).toBe(302);
    const [user] = await db.select().from(users).where(eq(users.provider, "apple"));
    expect(user.email).toBe("verified@example.com");
  });

  it("a returning user's callback (no 'user' field) reuses the existing row without erasing name/email", async () => {
    const [seeded] = await db
      .insert(users)
      .values({ provider: "apple", providerId: "apple-sub-1", email: "a@privaterelay.appleid.com", name: "A Person" })
      .returning();

    const app = buildServer();
    const stateResponse = await app.inject({ method: "GET", url: "/auth/apple" });
    const stateCookie = (Array.isArray(stateResponse.headers["set-cookie"]) ? stateResponse.headers["set-cookie"] : [stateResponse.headers["set-cookie"]])
      .find((c) => c?.includes("oneabobeall_oauth_state="))!;

    const response = await app.inject({
      method: "POST",
      url: "/auth/apple/callback",
      headers: { cookie: stateCookie.split(";")[0] },
      payload: { code: "mock-code", state: "mock-state" },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(process.env.PUBLIC_APP_URL + "/account");
    const rows = await db.select().from(users).where(eq(users.provider, "apple"));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(seeded.id);
    expect(rows[0].name).toBe("A Person");
    expect(rows[0].email).toBe("a@privaterelay.appleid.com");
  });
});
