import { describe, it, expect } from "vitest";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";

describe("FakePaymentProvider", () => {
  it("charges a deposit and returns a ref", async () => {
    const provider = new FakePaymentProvider();
    const ref = await provider.chargeDeposit("bidder-1", 1_000);
    expect(ref).toBeTruthy();
    expect(provider.charges).toEqual([{ bidderId: "bidder-1", amountCents: 1_000, ref }]);
  });

  it("charges the remainder successfully by default", async () => {
    const provider = new FakePaymentProvider();
    const ref = await provider.chargeDeposit("bidder-1", 1_000);
    const ok = await provider.chargeRemainder("bidder-1", 9_000, ref);
    expect(ok).toBe(true);
  });

  it("fails the next remainder charge on request, then resets", async () => {
    const provider = new FakePaymentProvider();
    const ref = await provider.chargeDeposit("bidder-1", 1_000);
    provider.failNextRemainderCharge();
    expect(await provider.chargeRemainder("bidder-1", 9_000, ref)).toBe(false);
    expect(await provider.chargeRemainder("bidder-1", 9_000, ref)).toBe(true);
  });

  it("tracks refunds", async () => {
    const provider = new FakePaymentProvider();
    const ref = await provider.chargeDeposit("bidder-1", 1_000);
    await provider.refund(ref);
    expect(provider.refunds).toEqual([ref]);
  });
});
