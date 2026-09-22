# Stripe Payment Integration Design

**Goal:** Replace the placeholder `PaymentProvider` (`FakePaymentProvider`) with a real Stripe
integration, and correct the deposit domain model to match the intended product rule: a
fixed, once-per-round entry deposit, not a per-bid charge. Ship the minimum live-backend
footprint needed to support it, deployed onto the existing Helsinki k3s cluster alongside
job-link/zavodhr.

**Business context:** Stripe is fully supported for a Spanish sole-proprietor (autónomo)
account — no foreign-entity workaround needed (that was a real blocker when Georgia was the
only entity considered; it no longer applies). Account setup, API keys, and webhook secrets
are obtained directly through the Spanish entity.

## Global Constraints

- All user-facing UI text is in English, regardless of what language design discussions happen in.
- Money is always handled in integer cents end-to-end (matches the rest of the engine).
- Non-payment after winning still results in a ban (3 rounds), including when the trigger is
  a card requiring extra authentication rather than an outright decline — no exception path.
- No email/notification system exists yet and none is being added for this feature.

---

## 1. Current State (what's wrong)

`apps/engine/src/payments/PaymentProvider.ts` models a synchronous "charge now, get a result
now" flow:

```ts
interface PaymentProvider {
  chargeDeposit(bidderId: string, amountCents: number): Promise<string>;
  chargeRemainder(bidderId: string, amountCents: number, depositRef: string): Promise<boolean>;
  refund(depositRef: string): Promise<void>;
}
```

`chargeDeposit` is called synchronously inside `placeBid` (`apps/engine/src/engine/placeBid.ts:58`),
computed as 10% of *that specific bid's* amount (`calculateDeposit`, `apps/engine/src/domain/deposit.ts`),
capped at $1,000.

This is wrong on two independent axes:

1. **Domain rule**: the deposit should be a single fixed amount per round, derived from the
   price the champion held when the round opened — the same for every participant, and
   independent of how much any individual bids. It is paid once, to unlock bidding for that
   round; raising your own bid afterward costs nothing more.
2. **Payment mechanics**: a real card charge cannot happen synchronously inside a server-side
   function call the way `FakePaymentProvider` pretends it can. Real Stripe card payments need
   the cardholder present (Stripe Elements, possibly 3D Secure), and final confirmation arrives
   asynchronously via webhook — not as a return value.

Both are fixed together in this design, because the corrected domain rule (fixed, one-time,
known-in-advance deposit) is what makes a clean Stripe flow possible: the amount is known
before the user even opens the payment form, so deposit collection can be a distinct "join
round" step instead of something interleaved with every bid.

## 2. User Flow

1. User sees a round and its fixed deposit amount (a percentage of the price the champion
   held when the round opened).
2. User clicks **"Join"** (English copy; exact wording TBD in implementation) → a Stripe
   Elements form appears → user enters card details and confirms a one-time payment for the
   deposit amount. The card is saved (`setup_future_usage: "off_session"`) for later reuse.
3. Once payment succeeds, the user can submit or raise bids freely for the rest of the
   bidding phase — no further payment step, regardless of how many times they change their bid.
4. When the round resolves:
   - **Loses**: deposit is refunded to the original card.
   - **Wins**: the remainder (final price − deposit) is charged automatically, off-session,
     against the saved card — no user action required. If that charge fails for any reason,
     including a bank requiring additional authentication (common for EU cards under PSD2/SCA
     even on saved cards), the existing non-payment rule applies: 3-round ban. No separate
     grace path — this keeps the feature shippable without building a notification system.

## 3. Domain Model Changes (`apps/engine`)

New entity, **`RoundParticipant`**: `{ roundId, bidderId, depositRef, depositCents, paidAt }` —
one row per (round, bidder), created once on successful deposit payment.

- `calculateDeposit` changes from `(bidAmountCents) => ...` to a function of the round's
  opening price (`reign.priceCents` at the moment the round starts), computed once when the
  round opens — not recomputed per bid or per participant.
- `placeBid` no longer calls any `PaymentProvider` method at all. Its new precondition: a
  `RoundParticipant` row must exist for `(roundId, bidderId)`; if not, it returns
  `{ ok: false, reason: "..." }` telling the caller to join (pay the deposit) first. Beyond
  that, bid validation (amount vs. current leader, phase/window checks) is unchanged.
- A new engine entry point, **`joinRound(bidderId, roundId, paymentIntentId, amountCents)`**,
  creates the `RoundParticipant` row. It does not take a `PaymentProvider` — it's called only
  after payment is already confirmed (by the Stripe webhook handler in `apps/api`), and must
  be idempotent: calling it twice with the same `paymentIntentId` must not create a second row
  or double-count the deposit (Stripe can redeliver webhooks). Implemented with the same
  claim-before-act discipline already used elsewhere in the engine (e.g. `confirmPayment`).
- Round resolution (`apps/engine/src/engine/roundResolution.ts`) changes its source for
  deposit data from the winning `bid` row to the winner's `RoundParticipant` row:
  `remainderCents = finalPriceCents - roundParticipant.depositCents`, and the existing
  refund-losers loop iterates `RoundParticipant` rows without a winning bid instead of `bid`
  rows.

The shrunk `PaymentProvider` interface (deposit creation/confirmation moves entirely to
`apps/api` + Stripe.js; the engine only initiates the remainder charge and refunds):

```ts
interface PaymentProvider {
  chargeRemainderOffSession(
    paymentMethodRef: string,
    amountCents: number,
  ): Promise<"succeeded" | "requires_action" | "failed">;
  refund(depositRef: string): Promise<void>;
}
```

`refund` stays synchronous/fire-and-forget from the engine's perspective — Stripe refunds are
a single synchronous API call, no cardholder interaction needed, so no async/webhook handling
is required for that path.

A `requires_action` or `failed` result from `chargeRemainderOffSession` is treated identically
to the existing non-payment path (3-round ban) — mirrors the existing transient-state pattern
used by `resolveBiddingPhaseSnapshot` (a `"processing"` offer state while awaiting the
webhook-driven outcome, analogous to the existing `"resolving"` round phase).

## 4. Stripe Integration Mechanics (`apps/api`)

**Deposit (user-initiated, on-session):**

1. `POST /api/rounds/:id/join` — `apps/api` first checks whether a `RoundParticipant` already
   exists for this `(roundId, bidderId)` and rejects (no-op, "already joined") if so — this
   guards against double-clicks or re-submits creating a second, redundant PaymentIntent for a
   bidder who already paid. Otherwise it creates a Stripe PaymentIntent for the round's fixed
   deposit amount, `setup_future_usage: "off_session"`, and returns `client_secret`.
2. Frontend renders Stripe Elements, user confirms (Stripe handles 3DS if required).
3. Stripe delivers `payment_intent.succeeded` to `POST /api/webhooks/stripe`. The handler
   verifies the signature (`STRIPE_WEBHOOK_SECRET`) and calls `joinRound(...)`.

**Remainder (engine-initiated, off-session):** triggered from the scheduler's existing
`tick()` during round resolution — creates and confirms an off-session PaymentIntent against
the saved payment method. Outcome arrives via the same webhook endpoint
(`payment_intent.succeeded` / `payment_intent.payment_failed` /
`payment_intent.requires_action` or equivalent), routed back into the engine's claim-before-act
resolution path.

**Refund (engine-initiated, synchronous):** a direct, synchronous call to Stripe's refund API
when a `RoundParticipant` loses.

All webhook handling must be idempotent — Stripe redelivers on any non-2xx response or timeout,
and the engine-side entry points (`joinRound`, remainder resolution) are written to tolerate
duplicate delivery via claim-before-act, not by deduplicating in the webhook handler itself.

## 5. Deployment

Target: the existing Helsinki k3s cluster (already running job-link.ru and zavodhr.ru behind
Traefik, TLS via cert-manager/Let's Encrypt). No new load balancer is needed — Traefik already
does host-based routing across multiple domains on this cluster.

- **Routing**: `oneabobeall.org/api/*` (path-based, not a subdomain) → `apps/api`, via a
  Traefik `Ingress` + `stripPrefix` `Middleware`, the same pattern already in production for
  MinIO under `zavodhr.ru/storage` (`infra/k8s/minio-storage-ingress.yaml` in job-link-boil).
  This reuses the apex domain's existing certificate — no new cert/DNS record needed.
- **Isolation**: new namespace `oneabobeall`, with its own Postgres deployment — kept separate
  from job-link's database rather than sharing its instance, given this app handles real money.
- **Build/deploy mechanics**: mirror job-link's existing approach exactly — build Docker images
  locally, import into k3s via `k3s ctr images import` (no external registry), secrets created
  via `kubectl create secret generic ... --from-env-file=...` (`STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `DATABASE_URL`, etc.).
- **Architecture note**: this breaks the invariant recorded in
  `docs/superpowers/specs/2026-08-06-public-page-delivery-design.md` — "no live/dynamic
  endpoint reachable from the browser." That document needs a follow-up amendment: the page
  itself (scene, leaderboard) stays statically built at CI time as before; only the new
  money-moving actions (join round, place bid, webhook receipt) are live, browser-reachable
  endpoints on `apps/api`. This is a deliberate, scoped exception, not a reversal of the
  original static-delivery design.

## 6. Testing

- `FakePaymentProvider` and every engine test currently exercising `chargeDeposit` are rewritten
  against the new interface and the new `joinRound` entry point.
- New engine tests: `joinRound` idempotency (duplicate `paymentIntentId`), `placeBid` rejecting
  a bidder with no `RoundParticipant` for the round, all three `chargeRemainderOffSession`
  outcomes (succeeded / requires_action→ban / failed→ban), refund path for non-winning
  `RoundParticipant` rows.
- `apps/api` tests: PaymentIntent creation (mocked Stripe SDK), webhook signature verification
  (valid and invalid), webhook idempotency.
- Manual, pre-merge verification against live Stripe test mode using Stripe's documented test
  cards (`4242 4242 4242 4242` for a plain success, `4000 0025 0000 3155` to exercise the 3DS/
  `requires_action` path) — not part of the automated suite, but required before merging.

## Out of Scope / Explicitly Deferred

- Google/Apple OAuth (paused by the user in favor of Stripe first; unrelated to this spec).
- Any notification/email system (the `requires_action` → ban simplification depends on this
  staying out of scope for now).
- YooKassa / RU payment path (separate, not covered here).
- A grace-period or retry UX for the SCA-declined remainder-charge case.
