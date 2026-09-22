import type { PaymentProvider } from "./PaymentProvider";

export class FakePaymentProvider implements PaymentProvider {
  remainderCharges: { paymentMethodRef: string; amountCents: number }[] = [];
  refunds: string[] = [];
  private nextRemainderResult: "succeeded" | "requires_action" | "failed" = "succeeded";

  async chargeRemainderOffSession(paymentMethodRef: string, amountCents: number): Promise<"succeeded" | "requires_action" | "failed"> {
    this.remainderCharges.push({ paymentMethodRef, amountCents });
    const result = this.nextRemainderResult;
    this.nextRemainderResult = "succeeded";
    return result;
  }

  async refund(depositRef: string): Promise<void> {
    this.refunds.push(depositRef);
  }

  failNextRemainderCharge(result: "requires_action" | "failed" = "failed"): void {
    this.nextRemainderResult = result;
  }
}
