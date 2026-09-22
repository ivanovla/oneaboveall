# Final whole-branch review — fix wave report

Branch: `stripe-payment-integration-engine-api` (worktree)
Date: 2026-09-22

All nine findings were addressed. Full test suites and typechecks pass in both
workspaces. Three deviations from the written instructions are documented at the
end; none of them reduce the scope of a fix, and one of them (the sweep's
refund/mark ordering) is a deliberate money-safety choice that departs from the
literal wording of the brief.

---

## 1. No Stripe Customer attachment (critical)

The deposit PaymentIntent set `setup_future_usage: "off_session"` but named no
Customer. Stripe only permits a saved PaymentMethod to be reused from a later,
*separate* PaymentIntent when that intent names the Customer the method is
attached to; without it, every winner's remainder charge would have failed with
`payment_method_unattached`, which the old catch-all flattened to `"failed"` —
i.e. forfeited deposit + 3-round ban for every bidder in every round.

Changes:

- **`apps/engine/src/db/schema.ts`** — added `customerRef: text("customer_ref").notNull()`
  to `roundParticipants`, beside `paymentMethodRef`, with a comment explaining
  why Stripe requires it. Applied with
  `npm run db:push --workspace=apps/engine -- --force`; verified against the
  running test database (`\d round_participants` shows `customer_ref text not null`).
- **`apps/api/src/routes/joinRound.ts`** — creates
  `stripe.customers.create({ metadata: { bidderId } })` before the PaymentIntent
  and passes `customer: customer.id` on the intent. A fresh Customer per join, as
  instructed — no persistent bidder→customer mapping exists and building one is
  out of scope.
- **`apps/api/src/routes/stripeWebhook.ts`** — extracts `customerRef` from
  `intent.customer` (tolerating the expanded-object form, same as the existing
  `payment_method` handling) and passes it to `joinRound`.
- **`apps/engine/src/engine/joinRound.ts`** — `customerRef: string` added to the
  params object and to the single `roundParticipants` insert.
- **`apps/engine/src/payments/PaymentProvider.ts`** — signature is now
  `chargeRemainderOffSession(customerRef, paymentMethodRef, amountCents)`.
- **`apps/api/src/payments/StripePaymentProvider.ts`** — matching signature;
  passes `customer: customerRef` on the remainder PaymentIntent.
- **`apps/engine/src/payments/FakePaymentProvider.ts`** — matching signature;
  `remainderCharges` now records `{ customerRef, paymentMethodRef, amountCents }`.
- **`apps/engine/src/engine/roundResolution.ts`** — `attemptOfferPayment` passes
  `participant.customerRef` as the new first argument.
- **Tests** — `customerRef` added to every direct `db.insert(roundParticipants).values(...)`
  across `apps/engine/tests` (schema, repository, repository.placeBidAtomic,
  placeBid, placeBid.atomicFailure, scheduler, roundResolution.snapshot,
  roundResolution.payment) and to every `joinRound(...)` call in
  `apps/engine/tests/engine/joinRound.test.ts`. `FakePaymentProvider.test.ts` and
  `apps/api/tests/payments/StripePaymentProvider.test.ts` updated to the 3-arg form.

New regression tests:

- `roundResolution.payment.test.ts` — "charges the remainder against the
  participant's saved Stripe customer, not just the payment method" asserts the
  exact `{ customerRef, paymentMethodRef, amountCents }` triple reaching the provider.
- `StripePaymentProvider.test.ts` — the happy-path assertion now requires
  `customer: "cus_1"` on the created PaymentIntent.
- `apps/api/tests/joinRound.test.ts` — asserts
  `customers.create({ metadata: { bidderId } })` is called and that the intent
  carries `customer: "cus_1"`.
- `schema.test.ts` — asserts `customerRef` round-trips through the column.

## 2. Catch-all treated every error as a card decline

`StripePaymentProvider.chargeRemainderOffSession` now maps to `"failed"` **only**
for `err.code === "authentication_required"` (→ `"requires_action"`) and
`err.type === "StripeCardError"` (→ `"failed"`). Everything else — auth errors,
connection errors, rate limits, `StripeInvalidRequestError`, plain untyped errors
— is re-thrown.

Verified (not just assumed) that a throw cannot reach a forfeit/ban path: in
`attemptOfferPayment` the charge happens *before* any of the `"expired"` /
`"forfeited"` / `bans` writes, so an exception aborts ahead of all three. Both
`settleRound` call sites in `scheduler.ts` are already inside per-item
`try`/`catch` blocks that log and continue. The residual effect is the
already-documented "offer stuck in `processing`" gap — the round is not closed,
no next round is started, the deposit stays `held`.

The `PaymentProvider` interface doc now states this contract explicitly, so a
future implementation cannot reintroduce the flattening by accident.

New tests:

- `StripePaymentProvider.test.ts` — parameterised "re-throws a %s instead of
  reporting it as a decline" over `StripeAuthenticationError`,
  `StripeConnectionError`, `StripeRateLimitError`, `StripeInvalidRequestError`;
  plus one for a plain untyped `Error`. The pre-existing "any other decline"
  test was rewritten into "returns 'failed' for a genuine card decline" with a
  properly typed `StripeCardError`.
- `roundResolution.payment.test.ts` — "never forfeits or bans when the provider
  throws an infrastructure error rather than declining": asserts the exception
  propagates, the deposit stays `held`, and the `bans` table stays empty.
- `scheduler.test.ts` — "a provider outage during settlement is logged and
  isolated": `tick()` resolves normally, no bans, deposit still `held`, and no
  next round was started.

## 3. Deposit with no `payment_method` was never refunded

`stripeWebhook.ts` now calls `await provider.refund(intent.id)` in that branch
(keeping the escalated error log). The refund is deliberately not wrapped in a
try/catch, so a failure produces a 500 and Stripe redelivers.

**Scope extension (deliberate):** the branch condition is now
`!paymentMethodRef || !customerRef`. Since finding #1 makes `customerRef`
required on the participant row, a succeeded deposit missing *either* ref is
equally unjoinable and equally in need of a refund. The log line reports which
one was missing.

New tests in `stripeWebhook.test.ts`: a parameterised pair covering a missing
`payment_method` and a missing `customer` (200, `joinRound` not called,
`refunds.create` called with the right `payment_intent`), plus "returns a
non-2xx when that refund itself fails, so Stripe redelivers".

## 4. Join route did not check the bidding window

`isBiddingOpen` is now exported from `apps/engine/src/engine/joinRound.ts` and
called in the API join route immediately after the `round.id !== roundId` check,
rejecting with **409** before any Stripe call. The engine-side check remains the
authoritative one (it is re-evaluated after the webhook arrives); this only stops
money moving in the common case.

New tests: 409 when the phase is still `"bidding"` but the 12h window has
elapsed, and 409 when the round has already moved to `"resolving"` — both
asserting neither `paymentIntents.create` nor `customers.create` was called.

## 5. Join route did not check for a ban

`isBanned(bidderId, now)` is called right after the window check, rejecting with
**403** before any Stripe call. New test: "rejects a banned bidder with 403 and
takes no money".

## 6. `settleRound` misreported a concurrent-claim loss

`settleRound`'s return type is now
`{ outcome: "paid" } | { outcome: "round-closed" } | { outcome: "already-processed" }`,
and the `"already-processed"` branch returns its own variant instead of
`"round-closed"`. Both `scheduler.ts` call sites match on `"round-closed"` only,
so they now correctly ignore a lost claim race and start no duplicate round — no
scheduler change was needed, as predicted. A doc comment on `settleRound` spells
out that callers must never treat the two alike.

New test: "reports losing the claim race as 'already-processed', distinct from
'round-closed'" (offer pre-set to `processing`; asserts the outcome and that no
charge was attempted).

## 7. Reconciliation sweep for held deposits on closed rounds

Added a third pass to `tick()`, after the existing two loops: an inner join of
`roundParticipants` (`depositStatus = 'held'`) against `rounds`
(`phase = 'closed'`), refunding each row. Per-row `try`/`catch` for isolation,
matching the pattern of both loops above it.

This retires all three residual gaps named in the brief: a mid-loop throw in
`closeRoundAndRefundHeld`, a failed refund in `joinRound`'s race-refund path, and
residue under a round that got stuck. As instructed, it does not attempt to
recover a round stuck in `"resolving"` itself.

New tests in `scheduler.test.ts`:

- "refunds a deposit left 'held' on an already-closed round" — the test the brief
  asked for: seeds `phase: "closed"` + a `held` row, runs `tick()`, asserts the
  row becomes `"refunded"` and `provider.refunds` contains its `depositRef`.
- "leaves a deposit 'held' (retryable) when the refund fails, and keeps sweeping
  the rest" — per-item isolation plus the ordering guarantee.
- "leaves deposits on rounds that are still open alone" — no over-reach.

## 8. Two hardening nits

- `apps/api/src/routes/placeBid.ts` — body validation is now
  `if (!bidderId || typeof bidderId !== "string" || typeof amountCents !== "number")`,
  matching the join route.
- `apps/engine/src/engine/scheduler.ts` — the crash-recovery poll guards the
  `round` destructure with an explicit `if (!round)` that logs
  `"payment offer … references missing round …; skipping"` and continues, instead
  of letting a bare `TypeError` be reported as "failed to settle".

## 9. Explicit `kind: "deposit"` marker

`joinRound.ts` (API) now sets `metadata: { kind: "deposit", roundId, bidderId }`
— `roundId`/`bidderId` retained, since the engine reads them. `stripeWebhook.ts`
identifies a deposit by `intent.metadata?.kind !== "deposit" || !roundId || !bidderId`.
New test: "ignores a succeeded PaymentIntent whose metadata lacks the
kind=deposit marker" (round metadata present, marker absent → ignored, no
`joinRound`, no refund).

---

## Verification

**`npm test --workspace=apps/engine`** — 16 files, **109 passed**, 0 failed
(baseline before this wave: 16 files / 102 passed; +7 new tests).

**`npm test --workspace=apps/api`** — 7 files, **50 passed**, 0 failed
(baseline: 7 files / 38 passed; +12 new tests).

**`npm run typecheck --workspace=apps/engine`** — clean, no output.
**`npm run typecheck --workspace=apps/api`** — clean, no output.

The schema change was applied to the worktree's own Postgres container
(`oneabobeall-stripe-plan-db`, port 5443) with
`npm run db:push --workspace=apps/engine -- --force`, and the resulting column
was inspected directly with `psql`.

---

## Deviations and concerns

**1. The sweep refunds before marking, not after claiming.** The brief suggested
a conditional `UPDATE ... WHERE deposit_status = 'held'` used "before/instead of"
an unconditional one. I did *not* claim-then-refund, because that ordering
contradicts a correctness fix this branch already made deliberately (commit
`392456e`, "correct joinRound's refund ordering", with the regression test
"leaves the row 'held' (not falsely 'refunded') if provider.refund throws"). If
the row were marked `refunded` first and the Stripe call then failed, nothing
would ever revisit that row and the bidder would silently lose their deposit —
a money-loss failure. Instead the sweep mirrors `joinRound` exactly: re-read the
row's status, refund, then conditional `UPDATE ... AND deposit_status = 'held'`.
The residual race with `closeRoundAndRefundHeld` is narrowed the same way
`joinRound` narrows it, and costs at most one duplicate refund call that Stripe
rejects — which the brief itself notes is harmless. Known cost of this choice: if
a process dies *between* a successful refund and the mark, the row stays `held`
and every later tick will retry a refund Stripe rejects, logging each time. That
is noisy but not a money bug, and it is strictly better than the alternative.

**2. The webhook refund branch also fires on a missing `customer`,** not only a
missing `payment_method` (see #3 above). Required for consistency with #1.

**3. A fresh Stripe Customer per join is a real (if minor) cost.** As instructed,
no lookup/reuse was built. Worth noting for the human: a bidder who joins N
rounds accumulates N Customer objects, each holding one card. Not a money-safety
issue; a natural follow-up alongside any future identity/auth work.

**Out of scope, untouched, as instructed:** no authentication added; no
production caller for `tick()`; no live Stripe test-mode run (step 8 is a human
pre-merge step); `STRIPE_CURRENCY` left at `"usd"`; no idempotency keys, no
abandoned-intent cancellation, no `.env.example` change, no migration files.

**Still open for the human's merge decision** (not code defects, restated for
convenience): the missing auth on money-moving routes, the currency question, and
the fact that nothing in production yet calls `tick()`.
