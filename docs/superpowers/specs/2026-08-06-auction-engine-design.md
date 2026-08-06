# Auction Engine — Design

## Context

oneabobeall.org is a single generative page: a crowd of people, with one person highlighted in the center. Hovering over anyone shows a small stats widget. There's one button ("Сместить" — "Displace") with the current price. The center spot is sold via a competitive, ever-running auction: whoever pays the most holds the spot, defends it for a minimum of one hour, and can be dethroned by a higher bid once that hour passes. Winning the spot means uploading a photo (with consent) that feeds an external regeneration pipeline, which rebuilds the page.

This spec covers **only the auction domain logic**: who currently holds the center spot, how challenger bids are accepted, how a round's winner is determined, the payment-cascade on non-payment, deposits, and bans. It intentionally excludes:

- Real payment provider integration (YooKassa, an international provider) — the engine only talks to an abstract `PaymentProvider` interface. Concrete providers are a separate subsystem.
- OAuth / authentication.
- The public page itself (rendering, hover widgets, leaderboard UI).
- Photo upload, consent capture, and invoking the external regeneration pipeline — the engine only emits an event when a new champion is installed; everything downstream is a separate subsystem.

## Domain Model

- **Champion** — the current center-spot holder: `occupant_id`, `price` (amount paid to win), `since` (timestamp installed).
- **Round** — one challenge cycle, tied 1:1 to a champion's reign. A round starts the moment a champion is installed and ends when that champion is dethroned (a new champion is installed).
- **Bid** — a challenger's bid placed during a round: `bidder_id`, `amount`, `deposit`, `placed_at`.
- **Deposit** — a hold taken when a bid is placed. Amount = a fixed percentage of the current champion's `price`, capped at $1000. Lifecycle: `held → refunded` or `held → forfeited`.
- **Ban** — a block on placing bids for the next 3 rounds, applied to a bidder who wins a round but fails to pay the remainder.
- **Reign** — a historical record written whenever a champion is dethroned or replaced: `occupant_id`, `price`, `started_at`, `ended_at`, `duration`. Powers the "who held the spot the longest" leaderboard. Note: `duration` for the currently active reign is computed on read (`now - started_at`), not stored, since the reign isn't over yet.

All monetary amounts are abstract integer minor units (e.g. cents) — currency and conversion are the payment subsystem's concern, not the engine's.

## Round State Machine

```
Champion installed (T0)
  │
  ├─ [T0, T0+1h]  PROTECTED — bids are accepted and queued.
  │                Each new bid must exceed the current queue leader
  │                (or the champion's price, if the queue is empty)
  │                by at least $1 minor-unit-equivalent (config: MIN_INCREMENT).
  │
  ├─ T0+1h snapshot:
  │    ├─ queue empty  → OPEN_DEFENSE (champion keeps the spot;
  │    │                  the next bid to arrive, whenever that is,
  │    │                  wins immediately — no further waiting)
  │    └─ queue non-empty → snapshot leader becomes winner-elect
  │
  ├─ winner-elect gets 1 hour to pay the remainder (amount − deposit)
  │    ├─ paid   → new Champion installed at `amount`; on_champion_installed
  │    │           event fires; every other bid in this round is refunded
  │    │           its deposit; Round closes; Reign record written for
  │    │           the outgoing champion.
  │    └─ unpaid → deposit forfeited; bidder banned for 3 rounds; offer
  │                moves to the next-highest bid from the ORIGINAL
  │                snapshot queue, who gets their own fresh 1-hour window.
  │                Repeats until someone pays or the queue is exhausted.
  │
  └─ queue exhausted without payment → champion remains; every deposit
       from this round's snapshot queue is refunded; engine returns to
       OPEN_DEFENSE (next bid to arrive wins immediately).
```

### Key rules

- **Minimum increment** applies uniformly: a new bid must beat the current leader (champion price, or top queued bid) by at least `MIN_INCREMENT` — whether the current leader is the champion or another challenger.
- **Ties** (identical bid amounts) are broken by earliest `placed_at`.
- **First bootstrap**: before any champion exists, the "price" is a fixed configured starting price. The first person to pay it becomes champion with no auction — there is nothing to out-bid yet.
- **Deposit refund timing**: non-winning bidders in a round (everyone except whoever ultimately succeeds in paying, if anyone) get their deposit back only after the round fully resolves — either someone pays, or the queue is exhausted. Bidders are not refunded incrementally as the cascade progresses.
- **Bans are enforced at bid placement**: a banned bidder cannot place a new bid at all, not just at resolution time.

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

- **State machine**: scenario tests driven by a fake/controllable clock — protected-phase queuing, open-defense instant-win, full cascade through multiple non-paying bidders, ties, concurrent-bid races.
- **Deposit calculation**: unit tests for the percentage-of-champion-price formula and the $1000 cap.
- **`PaymentProvider` boundary**: contract tests against a fake implementation of the interface — no real provider involved at this stage.
