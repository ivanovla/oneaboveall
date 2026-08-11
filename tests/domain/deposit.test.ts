import { describe, it, expect } from "vitest";
import { calculateDeposit } from "../../src/domain/deposit";

describe("calculateDeposit", () => {
  it("is 10% of the bid", () => {
    expect(calculateDeposit(10_000)).toBe(1_000);
  });

  it("rounds to the nearest cent", () => {
    expect(calculateDeposit(10_005)).toBe(1_001); // 1000.5 rounds up
  });

  it("caps at $1,000 (100,000 cents)", () => {
    expect(calculateDeposit(50_000_000)).toBe(100_000);
  });

  it("is exactly the cap at the boundary", () => {
    expect(calculateDeposit(1_000_000)).toBe(100_000);
  });
});
