import { describe, it, expect } from "vitest";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";

describe("FakePaymentProvider", () => {
  it("tracks releases", async () => {
    const provider = new FakePaymentProvider();
    await provider.release("pi_1");
    expect(provider.releases).toEqual(["pi_1"]);
  });

  it("captures successfully by default and records the attempt", async () => {
    const provider = new FakePaymentProvider();
    expect(await provider.capture("pi_1")).toEqual({ ok: true });
    expect(provider.captures).toEqual(["pi_1"]);
  });

  it("reports a definitive capture failure for refs it was told to decline", async () => {
    const provider = new FakePaymentProvider();
    provider.declineCapture.add("pi_1");
    expect(await provider.capture("pi_1")).toEqual({ ok: false, reason: expect.any(String) });
  });

  it("throws a transient capture error for refs it was told to fail transiently", async () => {
    const provider = new FakePaymentProvider();
    provider.throwOnCapture.add("pi_1");
    await expect(provider.capture("pi_1")).rejects.toThrow();
    expect(provider.captures).toEqual([]);
  });
});
