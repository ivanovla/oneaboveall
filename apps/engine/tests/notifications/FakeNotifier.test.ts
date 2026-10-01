import { describe, it, expect, vi } from "vitest";
import { FakeNotifier } from "../../src/notifications/FakeNotifier";
import { noopNotifier, notifySafely } from "../../src/notifications/Notifier";

describe("notifiers", () => {
  it("FakeNotifier records every call", async () => {
    const notifier = new FakeNotifier();
    await notifier.outbid({ bidderId: "a", amountCents: 100 });
    await notifier.won({ bidderId: "b", amountCents: 200 });
    expect(notifier.outbids).toEqual([{ bidderId: "a", amountCents: 100 }]);
    expect(notifier.wins).toEqual([{ bidderId: "b", amountCents: 200 }]);
  });

  it("noopNotifier does nothing and never throws", async () => {
    await expect(noopNotifier.outbid({ bidderId: "a", amountCents: 1 })).resolves.toBeUndefined();
    await expect(noopNotifier.won({ bidderId: "a", amountCents: 1 })).resolves.toBeUndefined();
  });

  it("notifySafely swallows and logs a notifier failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(notifySafely("outbid", () => Promise.reject(new Error("boom")))).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
