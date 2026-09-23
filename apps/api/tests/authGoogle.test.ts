import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

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

vi.mock("engine/db/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("engine/db/schema")>();
  return actual;
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
  it("rejects a missing state cookie with 400", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/auth/google/callback?code=x&state=y" });
    expect(response.statusCode).toBe(400);
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

    const { db, pool } = await import("engine/db/client");
    const { users, sessions } = await import("engine/db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await db.select().from(users).where(eq(users.provider, "google"));
    expect(user.email).toBe("a@example.com");
    expect(user.providerId).toBe("google-sub-1");
    // The session row (created by the callback) references this user via a
    // foreign key, so it must be deleted first or the users delete below
    // fails the FK constraint.
    await db.delete(sessions).where(eq(sessions.userId, user.id));
    await db.delete(users).where(eq(users.id, user.id));
    await pool.end();
  });
});
