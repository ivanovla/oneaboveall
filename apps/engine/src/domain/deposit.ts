import { DEPOSIT_PERCENT, DEPOSIT_CAP_CENTS } from "./config";

export function calculateDeposit(bidAmountCents: number): number {
  return Math.min(DEPOSIT_CAP_CENTS, Math.round(bidAmountCents * DEPOSIT_PERCENT));
}
