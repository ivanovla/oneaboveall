import { describe, it, expect } from "vitest";
import { sanitizeAttribution, sanitizeAttributionValue } from "../../src/domain/attribution";

describe("sanitizeAttributionValue", () => {
  it("accepts plain campaign-style tags", () => {
    for (const v of ["twitch", "streamer_bob", "launch-2026.10", "A", "x".repeat(64)]) {
      expect(sanitizeAttributionValue(v)).toBe(v);
    }
  });

  it("drops anything outside the allowed alphabet or length", () => {
    for (const v of ["", "x".repeat(65), "a b", "<script>", "bob/../x", "émile", "a&b=c", 42, null, undefined, {}]) {
      expect(sanitizeAttributionValue(v)).toBeNull();
    }
  });
});

describe("sanitizeAttribution", () => {
  it("sanitizes each field independently and ignores unknown keys", () => {
    expect(sanitizeAttribution({ ref: "bob", utmSource: "bad value", utmMedium: "stream", extra: "x" })).toEqual({
      ref: "bob",
      utmSource: null,
      utmMedium: "stream",
      utmCampaign: null,
      utmContent: null,
    });
  });

  it("tolerates a non-object body", () => {
    expect(sanitizeAttribution(null).ref).toBeNull();
    expect(sanitizeAttribution("ref=bob").ref).toBeNull();
  });
});
