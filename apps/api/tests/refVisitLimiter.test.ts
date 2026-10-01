import { describe, it, expect } from "vitest";
import { RefVisitLimiter } from "../src/routes/refVisitLimiter";

const MIN = 60_000;

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("RefVisitLimiter", () => {
  it("counts one visit per IP per ref per 30 minutes", () => {
    const c = clock();
    const limiter = new RefVisitLimiter({ now: c.now });

    expect(limiter.allow("1.1.1.1", "bob")).toBe(true);
    expect(limiter.allow("1.1.1.1", "bob")).toBe(false);
    // A different ref, or a different IP, is a separate visit.
    expect(limiter.allow("1.1.1.1", "alice")).toBe(true);
    expect(limiter.allow("2.2.2.2", "bob")).toBe(true);

    c.advance(29 * MIN);
    expect(limiter.allow("1.1.1.1", "bob")).toBe(false);
    c.advance(1 * MIN);
    expect(limiter.allow("1.1.1.1", "bob")).toBe(true);
  });

  it("counts at most 30 requests per IP per hour, whatever the ref — garbage refs included", () => {
    const c = clock();
    const limiter = new RefVisitLimiter({ now: c.now });

    for (let i = 0; i < 5; i++) expect(limiter.allow("1.1.1.1", null)).toBe(false);
    for (let i = 0; i < 25; i++) expect(limiter.allow("1.1.1.1", `ref${i}`)).toBe(true);
    // 31st request this hour: over budget even for a fresh ref.
    expect(limiter.allow("1.1.1.1", "fresh")).toBe(false);
    // Other IPs are unaffected.
    expect(limiter.allow("2.2.2.2", "fresh")).toBe(true);

    c.advance(60 * MIN);
    expect(limiter.allow("1.1.1.1", "fresh")).toBe(true);
  });

  it("keeps memory bounded: never tracks more than maxEntries keys per map", () => {
    const c = clock();
    const limiter = new RefVisitLimiter({ now: c.now, maxEntries: 100 });

    for (let i = 0; i < 1_000; i++) limiter.allow(`10.0.${Math.floor(i / 256)}.${i % 256}`, "bob");

    expect(limiter.size().ips).toBeLessThanOrEqual(100);
    expect(limiter.size().visits).toBeLessThanOrEqual(100);
  });

  it("evicts expired entries before dropping live ones", () => {
    const c = clock();
    const limiter = new RefVisitLimiter({ now: c.now, maxEntries: 10 });

    for (let i = 0; i < 9; i++) limiter.allow(`10.0.0.${i}`, "bob");
    c.advance(61 * MIN); // every entry above has expired
    limiter.allow("10.0.1.1", "bob");
    limiter.allow("10.0.1.2", "bob");

    // The nine expired entries went; the two live ones are both still there.
    expect(limiter.size().ips).toBe(2);
    expect(limiter.allow("10.0.1.1", "bob")).toBe(false);
  });
});
