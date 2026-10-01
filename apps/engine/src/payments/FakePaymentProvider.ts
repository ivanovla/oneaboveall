import type { CaptureResult, PaymentProvider } from "./PaymentProvider";

// In-memory stand-in for tests. Records every successful call, and can be
// told which refs should fail — definitively (declineCapture) or
// transiently (throwOnCapture / throwOnRelease) — to exercise settlement's
// fallback and retry paths.
export class FakePaymentProvider implements PaymentProvider {
  releases: string[] = [];
  captures: string[] = [];
  declineCapture = new Set<string>();
  throwOnCapture = new Set<string>();
  throwOnRelease = new Set<string>();

  async release(paymentRef: string): Promise<void> {
    if (this.throwOnRelease.has(paymentRef)) throw new Error(`FakePaymentProvider: transient release failure for ${paymentRef}`);
    this.releases.push(paymentRef);
  }

  async capture(paymentRef: string): Promise<CaptureResult> {
    if (this.throwOnCapture.has(paymentRef)) throw new Error(`FakePaymentProvider: transient capture failure for ${paymentRef}`);
    if (this.declineCapture.has(paymentRef)) return { ok: false, reason: "card_declined" };
    this.captures.push(paymentRef);
    return { ok: true };
  }
}
