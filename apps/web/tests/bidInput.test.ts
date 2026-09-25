import { describe, it, expect } from "vitest";
import { toBidInputValue, toWholeDollarCents } from "../src/lib/bidInput";

describe("toBidInputValue", () => {
  it("passes through plain digits", () => {
    expect(toBidInputValue("1500")).toBe("1500");
  });

  it("keeps a single decimal point", () => {
    expect(toBidInputValue("15.50")).toBe("15.50");
  });

  it("drops a second decimal point rather than let it reach parseFloat", () => {
    expect(toBidInputValue("1.2.3")).toBe("1.23");
  });

  it("strips non-digit, non-dot characters", () => {
    expect(toBidInputValue("$1,500a")).toBe("1500");
  });

  it("reproduces the actual keystroke-by-keystroke path for a typed decimal", () => {
    // Simulates a controlled input: each step's value is the PREVIOUS
    // accepted value plus the next character, not a precomputed string —
    // this is the distinction that separates a real regression test from
    // one that only proves a single whole-string change event works.
    let value = "";
    for (const char of "15.50") {
      value = toBidInputValue(value + char);
    }
    expect(value).toBe("15.50");
  });
});

describe("toWholeDollarCents", () => {
  it("converts a whole-dollar string to cents", () => {
    expect(toWholeDollarCents("1500")).toBe(150_000);
  });

  it("floors a decimal rather than concatenating its digits", () => {
    expect(toWholeDollarCents("15.50")).toBe(1_500); // $15, not $1,550
  });

  it("returns 0 for an empty string", () => {
    expect(toWholeDollarCents("")).toBe(0);
  });

  it("returns 0 for a lone decimal point", () => {
    expect(toWholeDollarCents(".")).toBe(0);
  });
});
