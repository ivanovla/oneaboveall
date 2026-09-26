export const MIN_INCREMENT_CENTS = 100; // $1

// Upper bound on any single bid. Deliberately well under Postgres's `integer`
// (int4) maximum of 2_147_483_647, which is the column type behind
// bids.amount_cents — an amount above that is rejected by the domain layer
// (before it is ever charged) instead of blowing up inside the insert.
export const MAX_BID_CENTS = 2_000_000_000; // $20,000,000

// A round's whole lifetime is its bidding window — settlement happens the
// instant it closes (the winner already paid in full when they bid, so there
// is nothing left to collect).
export const BIDDING_PHASE_MS = 12 * 60 * 60 * 1000;
export const ROUND_MS = BIDDING_PHASE_MS;

// Fixed price to become champion when no reign exists yet. Configurable later;
// there is nothing to out-bid before the first champion.
export const STARTING_PRICE_CENTS = 1_000; // $10
