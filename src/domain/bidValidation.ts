import { MIN_INCREMENT_CENTS } from "./config";

export type BidValidationResult = { valid: true } | { valid: false; reason: string };

export function validateBidAmount(bidAmountCents: number, currentLeaderCents: number): BidValidationResult {
  const minAllowed = currentLeaderCents + MIN_INCREMENT_CENTS;
  if (bidAmountCents < minAllowed) {
    return {
      valid: false,
      reason: `Bid must be at least ${minAllowed} cents (current leader ${currentLeaderCents} + minimum increment ${MIN_INCREMENT_CENTS}).`,
    };
  }
  return { valid: true };
}
