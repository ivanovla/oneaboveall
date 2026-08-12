export const MIN_INCREMENT_CENTS = 100; // $1

// Upper bound on any single bid. Deliberately well under Postgres's `integer`
// (int4) maximum of 2_147_483_647, which is the column type behind
// bids.amount_cents — an amount above that is rejected by the domain layer
// (before any deposit is charged) instead of blowing up inside the insert.
export const MAX_BID_CENTS = 2_000_000_000; // $20,000,000

export const DEPOSIT_PERCENT = 0.10;
export const DEPOSIT_CAP_CENTS = 100_000; // $1,000

export const BIDDING_PHASE_MS = 12 * 60 * 60 * 1000;
export const PAYMENT_PHASE_MS = 12 * 60 * 60 * 1000;
export const ROUND_MS = BIDDING_PHASE_MS + PAYMENT_PHASE_MS;
export const PAYMENT_ATTEMPT_MS = 60 * 60 * 1000; // 1h per cascade attempt

export const BAN_ROUNDS = 3;
export const BAN_DURATION_MS = BAN_ROUNDS * ROUND_MS;

// Fixed price to become champion when no reign exists yet. Configurable later;
// there is nothing to out-bid before the first champion.
export const STARTING_PRICE_CENTS = 10_000; // $100
