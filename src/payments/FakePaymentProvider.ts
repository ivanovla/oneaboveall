import type { PaymentProvider } from "./PaymentProvider";

export class FakePaymentProvider implements PaymentProvider {
  charges: { bidderId: string; amountCents: number; ref: string }[] = [];
  refunds: string[] = [];
  private failNextRemainder = false;

  async chargeDeposit(bidderId: string, amountCents: number): Promise<string> {
    const ref = `dep_${this.charges.length + 1}`;
    this.charges.push({ bidderId, amountCents, ref });
    return ref;
  }

  async chargeRemainder(_bidderId: string, _amountCents: number, _depositRef: string): Promise<boolean> {
    if (this.failNextRemainder) {
      this.failNextRemainder = false;
      return false;
    }
    return true;
  }

  async refund(depositRef: string): Promise<void> {
    this.refunds.push(depositRef);
  }

  failNextRemainderCharge(): void {
    this.failNextRemainder = true;
  }
}
