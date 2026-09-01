export interface PaymentProvider {
  chargeDeposit(bidderId: string, amountCents: number): Promise<string>;
  chargeRemainder(bidderId: string, amountCents: number, depositRef: string): Promise<boolean>;
  refund(depositRef: string): Promise<void>;
}
