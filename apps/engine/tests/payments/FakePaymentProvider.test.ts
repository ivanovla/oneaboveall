import { describe, it, expect } from "vitest";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";

describe("FakePaymentProvider", () => {
  it("charges the remainder successfully by default and records it", async () => {
    const provider = new FakePaymentProvider();
    const result = await provider.chargeRemainderOffSession("pm_1", 9_000);
    expect(result).toBe("succeeded");
    expect(provider.remainderCharges).toEqual([{ paymentMethodRef: "pm_1", amountCents: 9_000 }]);
  });

  it("fails the next remainder charge on request (defaulting to 'failed'), then resets", async () => {
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge();
    expect(await provider.chargeRemainderOffSession("pm_1", 9_000)).toBe("failed");
    expect(await provider.chargeRemainderOffSession("pm_1", 9_000)).toBe("succeeded");
  });

  it("can script a 'requires_action' result specifically", async () => {
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("requires_action");
    expect(await provider.chargeRemainderOffSession("pm_1", 9_000)).toBe("requires_action");
  });

  it("tracks refunds", async () => {
    const provider = new FakePaymentProvider();
    await provider.refund("pi_1");
    expect(provider.refunds).toEqual(["pi_1"]);
  });
});
