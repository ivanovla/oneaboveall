import { describe, it, expect } from "vitest";
import { validateBidAmount } from "../../src/domain/bidValidation";
import { MAX_BID_CENTS } from "../../src/domain/config";

describe("validateBidAmount", () => {
  it("rejects a bid equal to the current leader", () => {
    const result = validateBidAmount(10_000, 10_000);
    expect(result.valid).toBe(false);
  });

  it("rejects a bid less than one increment above the leader", () => {
    const result = validateBidAmount(10_050, 10_000);
    expect(result.valid).toBe(false);
  });

  it("accepts a bid exactly one increment above the leader", () => {
    const result = validateBidAmount(10_100, 10_000);
    expect(result.valid).toBe(true);
  });

  it("accepts a bid well above the leader", () => {
    const result = validateBidAmount(20_000, 10_000);
    expect(result.valid).toBe(true);
  });

  it("rejects NaN and Infinity — they slip through every `<` comparison", () => {
    expect(validateBidAmount(NaN, 10_000).valid).toBe(false);
    expect(validateBidAmount(Infinity, 10_000).valid).toBe(false);
  });

  it("rejects a fractional amount", () => {
    expect(validateBidAmount(10_100.5, 10_000).valid).toBe(false);
  });

  it("rejects zero and negative amounts", () => {
    expect(validateBidAmount(0, -10_000).valid).toBe(false);
    expect(validateBidAmount(-10_100, -20_000).valid).toBe(false);
  });

  it("rejects an amount above MAX_BID_CENTS (int4 overflow territory)", () => {
    expect(validateBidAmount(MAX_BID_CENTS + 1, 10_000).valid).toBe(false);
    expect(validateBidAmount(3_000_000_000, 10_000).valid).toBe(false);
    expect(validateBidAmount(MAX_BID_CENTS, 10_000).valid).toBe(true);
  });

  it("includes a human-readable reason when rejected", () => {
    const result = validateBidAmount(10_000, 10_000);
    if (result.valid) throw new Error("expected invalid");
    expect(result.reason).toContain("10100");
  });
});
