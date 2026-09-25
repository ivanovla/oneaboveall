import { describe, it, expect } from "vitest";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";

describe("FakePaymentProvider", () => {
  it("tracks refunds", async () => {
    const provider = new FakePaymentProvider();
    await provider.refund("pi_1");
    expect(provider.refunds).toEqual(["pi_1"]);
  });
});
