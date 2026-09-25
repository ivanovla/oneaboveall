import { describe, it, expect } from "vitest";
import { formatMoney, formatCountdown } from "../src/lib/format";

describe("formatMoney", () => {
  it("formats cents as a dollar string with thousands separators", () => {
    expect(formatMoney(421_000)).toBe("$4,210");
  });

  it("rounds to the nearest dollar", () => {
    expect(formatMoney(100_050)).toBe("$1,001"); // $1,000.50 rounds up
  });
});

describe("formatCountdown", () => {
  it("formats milliseconds as HH:MM:SS", () => {
    expect(formatCountdown((6 * 3600 + 41 * 60 + 12) * 1000)).toBe("06:41:12");
  });

  it("clamps negative remaining time to zero", () => {
    expect(formatCountdown(-5000)).toBe("00:00:00");
  });
});
