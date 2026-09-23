import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { buildServer } from "../src/server";
import { db, pool } from "engine/db/client";
import { users, sessions } from "engine/db/schema";
import { eq } from "drizzle-orm";

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
});

describe("GET /auth/google/callback", () => {
  it("redirects to the app with an error when the state cookie is missing, without exchanging any code", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/auth/google/callback?code=x&state=y" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${process.env.PUBLIC_APP_URL}/?error=sign_in_failed`);
    expect(callback).not.toHaveBeenCalled();
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
  });
});
