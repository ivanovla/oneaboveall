import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ATTRIBUTION_STORAGE_KEY,
  REF_VISIT_SESSION_KEY,
  captureAttribution,
  parseAttribution,
  readStoredAttribution,
  sendAttributionIfNeeded,
} from "../src/lib/attribution";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  global.fetch = vi.fn(async () => ({ ok: true, status: 204 })) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseAttribution", () => {
  it("extracts ref and utm_* tags", () => {
    const parsed = parseAttribution("?ref=bob&utm_source=twitch&utm_medium=stream&utm_campaign=launch&utm_content=clip1&x=1", new Date("2026-10-02T00:00:00Z"));
    expect(parsed).toEqual({
      ref: "bob",
      utmSource: "twitch",
      utmMedium: "stream",
      utmCampaign: "launch",
      utmContent: "clip1",
      landingAt: "2026-10-02T00:00:00.000Z",
    });
  });

  it("normalizes values so they survive the server's sanitization (^[A-Za-z0-9_.-]{1,64}$)", () => {
    const parsed = parseAttribution(
      `?ref=${encodeURIComponent(" Bob's Stream! ")}&utm_campaign=launch%20day&utm_source=tw%C3%AFtch&utm_content=${"x".repeat(80)}`,
      new Date("2026-10-02T00:00:00Z"),
    );
    expect(parsed).toEqual({
      ref: "Bobs-Stream",
      utmCampaign: "launch-day",
      utmSource: "twtch",
      utmContent: "x".repeat(64),
      landingAt: "2026-10-02T00:00:00.000Z",
    });
  });

  it("treats a value with nothing usable left as absent", () => {
    expect(parseAttribution("?ref=%F0%9F%8E%AE%F0%9F%8E%AE")).toBeNull();
  });

  it("returns null without any attribution params", () => {
    expect(parseAttribution("")).toBeNull();
    expect(parseAttribution("?foo=bar&ref=")).toBeNull();
  });
});

describe("captureAttribution", () => {
  it("stores first touch, never overwrites it, and posts the ref visit once per session", () => {
    captureAttribution("http://api.test", "?ref=bob&utm_source=twitch");
    captureAttribution("http://api.test", "?ref=alice");

    expect(readStoredAttribution()).toMatchObject({ ref: "bob", utmSource: "twitch" });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://api.test/ref-visits",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ ref: "bob" }) }),
    );
    expect(sessionStorage.getItem(REF_VISIT_SESSION_KEY)).toBe("1");
  });

  it("stores utm-only attribution without posting a ref visit", () => {
    captureAttribution("http://api.test", "?utm_source=newsletter");
    expect(readStoredAttribution()).toMatchObject({ utmSource: "newsletter" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does nothing on a plain visit", () => {
    captureAttribution("http://api.test", "");
    expect(localStorage.getItem(ATTRIBUTION_STORAGE_KEY)).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => captureAttribution("http://api.test", "?ref=bob")).not.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("sendAttributionIfNeeded", () => {
  it("PATCHes the stored attribution once and marks it sent", async () => {
    captureAttribution("http://api.test", "?ref=bob&utm_campaign=launch");
    vi.mocked(global.fetch).mockClear();

    await sendAttributionIfNeeded("http://api.test");
    await sendAttributionIfNeeded("http://api.test");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/auth/attribution");
    expect(init.method).toBe("PATCH");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body as string)).toEqual({ ref: "bob", utmCampaign: "launch" });
    expect(readStoredAttribution()?.sentAt).toBeTruthy();
  });

  it("keeps it unsent after a failure so a later load retries", async () => {
    captureAttribution("http://api.test", "?ref=bob");
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await sendAttributionIfNeeded("http://api.test");
    expect(readStoredAttribution()?.sentAt).toBeUndefined();
  });

  it("does nothing without stored attribution", async () => {
    await sendAttributionIfNeeded("http://api.test");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
