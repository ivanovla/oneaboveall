import type { PaymentProvider } from "./PaymentProvider";

export class FakePaymentProvider implements PaymentProvider {
  refunds: string[] = [];

  async refund(paymentRef: string): Promise<void> {
    this.refunds.push(paymentRef);
  }
}
