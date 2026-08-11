import { describe, it, expect } from "vitest";
import { AUCTION_ENGINE_VERSION } from "../src/index";

describe("scaffold", () => {
  it("package resolves", () => {
    expect(AUCTION_ENGINE_VERSION).toBe("0.1.0");
  });
});
