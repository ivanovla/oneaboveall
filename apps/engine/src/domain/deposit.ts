import { DEPOSIT_PERCENT, DEPOSIT_CAP_CENTS } from "./config";

export function calculateDeposit(roundOpenPriceCents: number): number {
  return Math.min(DEPOSIT_CAP_CENTS, Math.round(roundOpenPriceCents * DEPOSIT_PERCENT));
}
