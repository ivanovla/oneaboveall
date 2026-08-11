import { describe, it, expect } from "vitest";
import { validateBidAmount } from "../../src/domain/bidValidation";

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

  it("includes a human-readable reason when rejected", () => {
    const result = validateBidAmount(10_000, 10_000);
    if (result.valid) throw new Error("expected invalid");
    expect(result.reason).toContain("10100");
  });
});
