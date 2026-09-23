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
    expect(response.headers.location).toBe(process.env.PUBLIC_APP_URL + "/account");
    const cookies = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [response.headers["set-cookie"]];
    expect(cookies.some((c) => c?.includes("oneabobeall_session="))).toBe(true);
    expect(getSetCookieHeader(response, OAUTH_STATE_COOKIE_NAME)).toMatch(/Expires=Thu, 01 Jan 1970/);

    const [user] = await db.select().from(users).where(eq(users.provider, "apple"));
    expect(user.providerId).toBe("apple-sub-1");
    expect(user.name).toBe("A Person");
    expect(user.email).toBe("a@privaterelay.appleid.com");
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
