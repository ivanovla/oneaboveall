import { describe, it, expect } from "vitest";
import { calculateDeposit } from "../../src/domain/deposit";

describe("calculateDeposit", () => {
  it("is 10% of the round's opening price", () => {
    expect(calculateDeposit(10_000)).toBe(1_000);
  });

  it("rounds to the nearest cent", () => {
    expect(calculateDeposit(10_005)).toBe(1_001); // 1000.5 rounds up
  });

  it("caps at $10,000 (1,000,000 cents)", () => {
    expect(calculateDeposit(500_000_000)).toBe(1_000_000);
  });

  it("is exactly the cap at the boundary", () => {
    expect(calculateDeposit(10_000_000)).toBe(1_000_000);
  });

  it("floors at $1 (100 cents) for a very cheap round", () => {
    expect(calculateDeposit(500)).toBe(100); // 10% of $5 is $0.50, floored to $1
  });

  it("is exactly the floor at the boundary", () => {
    expect(calculateDeposit(1_000)).toBe(100); // 10% of $10 is exactly $1
  });
});
