import { DEPOSIT_PERCENT, DEPOSIT_MIN_CENTS, DEPOSIT_CAP_CENTS } from "./config";

export function calculateDeposit(roundOpenPriceCents: number): number {
  const raw = Math.round(roundOpenPriceCents * DEPOSIT_PERCENT);
  return Math.min(DEPOSIT_CAP_CENTS, Math.max(DEPOSIT_MIN_CENTS, raw));
}
