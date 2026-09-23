import { describe, it, expect, vi, afterEach } from "vitest";
import { buildServer } from "../src/server";

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

  it("boots normally with a concrete origin, including a multi-origin list", () => {
    process.env.CORS_ORIGIN = "http://127.0.0.1:4321";
    expect(() => buildServer()).not.toThrow();

    process.env.CORS_ORIGIN = "http://127.0.0.1:4321,https://oneabobeall.org";
    expect(() => buildServer()).not.toThrow();
  });
});
