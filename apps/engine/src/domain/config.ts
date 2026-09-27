export const MIN_INCREMENT_CENTS = 100; // $1

// Upper bound on any single bid. Deliberately well under Postgres's `integer`
// (int4) maximum of 2_147_483_647, which is the column type behind
// bids.amount_cents — an amount above that is rejected by the domain layer
// (before it is ever charged) instead of blowing up inside the insert.
export const MAX_BID_CENTS = 2_000_000_000; // $20,000,000

// When a round's bidding actually closes is computed by
// domain/dailyClose.ts's nextDailyCloseAt() — always 4pm America/New_York,
// not a fixed duration after the round started (see that file's own
// comment). A round's length therefore varies day to day; only its close
// time is fixed. Settlement (freezing the leader) happens the instant that
// close time passes — the winner already paid in full when they bid, so
// there is nothing left to collect — but see CHAMPION_PROCESSING_GAP_MS
// below for when that winner is actually installed as champion.

// Only applies when a round actually has a winner. The scheduler (see
// scheduler.ts's tick()) waits this long past the daily close time before
// installing them as champion, so the outgoing champion keeps showing on the
// public scene (getScene() still returns their still-open reign) while their
// replacement's photo/artwork is prepared and the site redeployed with it.
// An empty round (nobody bid) skips this entirely and rolls into its reign's
// next round immediately — there is no new champion whose artwork needs
// preparing.
export const CHAMPION_PROCESSING_GAP_MS = 3 * 60 * 60 * 1000;

// Fixed price to become champion when no reign exists yet. Configurable later;
// there is nothing to out-bid before the first champion.
export const STARTING_PRICE_CENTS = 1_000; // $10
