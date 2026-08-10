# Auction Engine — Design

## Context

oneabobeall.org is a single generative page: a crowd of people, with one person highlighted in the center. Hovering over anyone shows a small stats widget. There's one button ("Сместить" — "Displace") with the current price. The center spot is sold via a competitive, ever-running auction: whoever pays the most holds the spot, defends it for a minimum of one day, and can be dethroned by a higher bid once that day's bidding window passes. Winning the spot means uploading a photo (with consent) that feeds an external regeneration pipeline, which rebuilds the page.

This spec covers **only the auction domain logic**: who currently holds the center spot, how challenger bids are accepted, how a round's winner is determined, the payment-cascade on non-payment, deposits, and bans. It intentionally excludes:

- Real payment provider integration (YooKassa, an international provider) — the engine only talks to an abstract `PaymentProvider` interface. Concrete providers are a separate subsystem.
- OAuth / authentication.
- The public page itself (rendering, hover widgets, leaderboard UI).
- Photo upload, consent capture, and invoking the external regeneration pipeline — the engine only emits an event when a new champion is installed; everything downstream is a separate subsystem.

## Domain Model

- **Champion** — the current center-spot holder: `occupant_id`, `price` (amount paid to win), `since` (timestamp installed).
- **Reign** — a champion's entire continuous holding period, from installation to dethronement. A reign is made up of one or more consecutive **Rounds** — it keeps going, round after round, for as long as nobody manages to pay to take the spot.
- **Round** — one 24-hour challenge cycle within a reign. A new round starts every day at the same time as the champion was installed, for as long as the reign continues. Each round independently runs the bidding/payment cycle described below.
- **Bid** — a challenger's bid placed during a round: `bidder_id`, `amount`, `deposit`, `placed_at`.
- **Deposit** — a hold taken when a bid is placed. Amount = a fixed percentage of the current champion's `price`, capped at $1000. Lifecycle: `held → refunded` or `held → forfeited`.
- **Ban** — a block on placing bids for the next 3 rounds (i.e. roughly 3 days), applied to a bidder who wins a round but fails to pay the remainder.
- **ReignHistory** — a historical record written whenever a reign ends (the champion is dethroned): `occupant_id`, `price`, `started_at`, `ended_at`, `duration`. Powers the "who held the spot the longest" leaderboard. Note: `duration` for the currently active reign is computed on read (`now - started_at`), not stored, since the reign isn't over yet.

All monetary amounts are abstract integer minor units (e.g. cents) — currency and conversion are the payment subsystem's concern, not the engine's.

## Round State Machine

Every round is a fixed 24-hour cycle, split into two 12-hour halves:

```
Round starts (T0 = champion's install time, or the same time-of-day
              on each subsequent day of an ongoing reign)
  │
  ├─ [T0, T0+12h]  BIDDING — bids are accepted and queued.
  │                 Each new bid must exceed the current queue leader
  │                 (or the champion's price, if the queue is empty)
  │                 by at least $1 minor-unit-equivalent (config: MIN_INCREMENT).
  │
  ├─ T0+12h snapshot:
  │    ├─ queue empty  → Round closes with no change. Champion keeps
  │    │                  the spot. The next Round starts at T0+24h
  │    │                  (bidding is NOT accepted in between).
  │    └─ queue non-empty → snapshot leader becomes winner-elect
  │
  ├─ [T0+12h, T0+24h]  PAYMENT/CASCADE — a single shared 12-hour budget
  │    for the whole cascade, not a fresh budget per bidder.
  │    The winner-elect gets up to 1 hour to pay the remainder
  │    (amount − deposit), counted against this shared budget:
  │    ├─ paid   → new Champion installed at `amount`; on_champion_installed
  │    │           event fires; every other bid in this round is refunded
  │    │           its deposit; the outgoing champion's reign ends and a
  │    │           ReignHistory record is written; the new champion starts
  │    │           a fresh reign (and fresh round) immediately.
  │    └─ unpaid → deposit forfeited; bidder banned for 3 rounds; offer
  │                moves to the next-highest bid from the ORIGINAL
  │                snapshot queue, who gets up to 1 hour of whatever
  │                budget remains before T0+24h.
  │                Repeats until someone pays, the queue is exhausted,
  │                or the T0+24h boundary is reached — whichever comes
  │                first. A bidder who never gets reached before the
  │                boundary simply doesn't get a turn this round.
  │
  └─ T0+24h reached without payment → champion remains; every deposit
       from this round's snapshot queue is refunded; a new Round starts
       immediately (back to BIDDING).
```

### Key rules

- **Minimum increment** applies uniformly: a new bid must beat the current leader (champion price, or top queued bid) by at least `MIN_INCREMENT` — whether the current leader is the champion or another challenger.
- **Ties** (identical bid amounts) are broken by earliest `placed_at`.
- **First bootstrap**: before any champion exists, the "price" is a fixed configured starting price. The first person to pay it becomes champion with no auction — there is nothing to out-bid yet.
- **Deposit refund timing**: non-winning bidders in a round (everyone except whoever ultimately succeeds in paying, if anyone) get their deposit back only after that round fully resolves — either someone pays, the queue is exhausted, or the round's 24h boundary is reached. Bidders are not refunded incrementally as the cascade progresses, and deposits do not carry over to the next day's round — a bidder who wants to compete again places a fresh bid (and fresh deposit) in the new round.
- **Bans are enforced at bid placement**: a banned bidder cannot place a new bid at all, not just at resolution time.
- **No "instant win" mode**: unlike a plain always-open challenge window, a round with zero bids simply closes and waits for the next day's round — there's no state where the very next bid to arrive wins immediately outside of a round's 12h bidding window.

## Interfaces to Other Subsystems

- **`PaymentProvider`** (implemented by the payments subsystem):
  - `chargeDeposit(bidderId, amount) → depositRef`
  - `chargeRemainder(bidderId, amount, depositRef) → success/fail`
  - `refund(depositRef)`
  - Payment confirmation is asynchronous (provider webhooks). The engine exposes `confirmPayment(bidId)` for the payment subsystem to call on success, and a scheduler independently evaluates each payment deadline (absolute timestamp, not wall-clock-relative) to advance the cascade if nothing was confirmed in time.
- **`on_champion_installed(occupant_id)`** — event fired when a round resolves with a new champion. The photo-upload/regeneration-pipeline subsystem listens for this to prompt the winner to upload a photo and consent, then trigger the external pipeline.

## Edge Cases

- **Concurrent bids** racing to become "current leader" are resolved via a serializable transaction / atomic compare-and-swap on the leader slot — no two bids can both believe they're leading.
- **Banned bidder** attempting to bid is rejected at submission, before a deposit charge is even attempted.
- **System downtime** during a payment window doesn't extend or shrink it: deadlines are stored as absolute timestamps: on recovery, the scheduler re-evaluates every pending deadline against the stored value, not against elapsed wall-clock time since restart.

## Testing Approach

- **State machine**: scenario tests driven by a fake/controllable clock — bidding-phase queuing, empty-round roll-to-next-day, full cascade through multiple non-paying bidders within and exceeding the 12h payment budget, ties, concurrent-bid races, a reign spanning multiple consecutive rounds.
- **Deposit calculation**: unit tests for the percentage-of-champion-price formula and the $1000 cap.
- **`PaymentProvider` boundary**: contract tests against a fake implementation of the interface — no real provider involved at this stage.
