import { MAX_BID_CENTS, MIN_INCREMENT_CENTS } from "./config";

export type BidValidationResult = { valid: true } | { valid: false; reason: string };

export function validateBidAmount(bidAmountCents: number, currentLeaderCents: number): BidValidationResult {
  // Shape checks come first, before the increment comparison: NaN and Infinity
  // silently pass every `<` comparison, and an out-of-range amount would only
  // fail deep inside the insert (Postgres 22003/22P02) — after the deposit has
  // already been charged. bids.amount_cents is an int4 column, so anything that
  // is not a safe, positive, in-range integer must never reach the database.
  if (!Number.isSafeInteger(bidAmountCents)) {
    return { valid: false, reason: `Bid amount must be a whole number of cents (received ${bidAmountCents}).` };
  }
  if (bidAmountCents <= 0) {
    return { valid: false, reason: `Bid amount must be greater than zero (received ${bidAmountCents}).` };
  }
  if (bidAmountCents > MAX_BID_CENTS) {
    return { valid: false, reason: `Bid amount must not exceed ${MAX_BID_CENTS} cents (received ${bidAmountCents}).` };
  }

  const minAllowed = currentLeaderCents + MIN_INCREMENT_CENTS;
  if (bidAmountCents < minAllowed) {
    return {
      valid: false,
      reason: `Bid must be at least ${minAllowed} cents (current leader ${currentLeaderCents} + minimum increment ${MIN_INCREMENT_CENTS}).`,
    };
  }
  return { valid: true };
}
