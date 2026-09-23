import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { buildServer } from "../src/server";
import { pool } from "engine/db/client";

vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

const ORIGINAL_CORS_ORIGIN = process.env.CORS_ORIGIN;

afterEach(() => {
  if (ORIGINAL_CORS_ORIGIN === undefined) {
    delete process.env.CORS_ORIGIN;
  } else {
    process.env.CORS_ORIGIN = ORIGINAL_CORS_ORIGIN;
  }
});

// The header tests below hit a real route (GET /scene), which opens the
// engine's pg pool — same cleanup as the other DB-touching suites.
afterAll(async () => {
  await pool.end();
});

describe("buildServer — CORS_ORIGIN validation", () => {
  it("throws when CORS_ORIGIN is missing", () => {
    delete process.env.CORS_ORIGIN;
    expect(() => buildServer()).toThrow(/CORS_ORIGIN is required/);
  });

  // Every route here is credentialed (`credentials: true`, needed for the
  // session and OAuth-state cookies), and the CORS spec forbids pairing that
  // with a wildcard origin. The rejection happens in the BROWSER, so a
  // wildcard boots fine and then fails every real cross-origin request with
  // nothing on the server side to show for it. Failing at boot is the whole
  // point of this check.
  it("throws when CORS_ORIGIN is a bare wildcard", () => {
    process.env.CORS_ORIGIN = "*";
    expect(() => buildServer()).toThrow(/must not be "\*"/);
  });

  it("throws when a wildcard hides inside a comma-separated list", () => {
    process.env.CORS_ORIGIN = "http://127.0.0.1:4321, *";
    expect(() => buildServer()).toThrow(/must not be "\*"/);
  });

  it("throws when CORS_ORIGIN is only separators", () => {
    process.env.CORS_ORIGIN = " , ";
    expect(() => buildServer()).toThrow(/CORS_ORIGIN is required/);
  });

  it("boots normally with a concrete origin", () => {
    process.env.CORS_ORIGIN = "http://127.0.0.1:4321";
    expect(() => buildServer()).not.toThrow();
  });
});

// Booting is not the same as working: @fastify/cors treats a STRING `origin`
// as a literal echoed verbatim, so a comma-separated CORS_ORIGIN used to
// produce `Access-Control-Allow-Origin: http://a,https://b` — a header every
// browser rejects — while a boot-only assertion showed green. These tests go
// through the actual response headers instead.
describe("buildServer — CORS response headers", () => {
  it("echoes back whichever configured origin the request came from", async () => {
    process.env.CORS_ORIGIN = "http://127.0.0.1:4321, https://oneabobeall.org";
    const app = buildServer();

    const first = await app.inject({ method: "GET", url: "/scene", headers: { origin: "http://127.0.0.1:4321" } });
    expect(first.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:4321");
    expect(first.headers["access-control-allow-credentials"]).toBe("true");

    const second = await app.inject({ method: "GET", url: "/scene", headers: { origin: "https://oneabobeall.org" } });
    expect(second.headers["access-control-allow-origin"]).toBe("https://oneabobeall.org");
    expect(second.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("never emits a comma-joined allow-origin header", async () => {
    process.env.CORS_ORIGIN = "http://127.0.0.1:4321,https://oneabobeall.org";
    const app = buildServer();

    const response = await app.inject({ method: "GET", url: "/scene", headers: { origin: "http://127.0.0.1:4321" } });
    expect(String(response.headers["access-control-allow-origin"])).not.toContain(",");
  });

  it("does not allow an origin that isn't configured", async () => {
    process.env.CORS_ORIGIN = "http://127.0.0.1:4321";
    const app = buildServer();

    const response = await app.inject({ method: "GET", url: "/scene", headers: { origin: "https://evil.example" } });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
