# Launch Readiness — Design

## Context

Marketing launch (see `docs/marketing/2026-10-01-launch-strategy.md`) targets
Western audiences via small streamers. Before that, the product needs:
payments that don't lose money on bid wars, attribution per streamer, legal
pages Stripe/EU require, link previews, live "who's leading" drama, an OBS
overlay, moderation/sponsor tooling, and outbid/won emails.

Decisions made by the owner (2026-10-02):

- Bids become **authorization holds** (Stripe `capture_method: "manual"`),
  captured only for the round's winner.
- If capturing the winner fails, **fall back to the previous leader** (their
  hold is kept until the round settles).
- Email provider: **Resend**.
- Refund policy: "**You pay only if you win**" — a section in Terms, no
  separate page.
- Seller: **Devvally, Spain**, contact **oneabovealldotorg@gmail.com**.
- When done: merge to `main` and deploy.

## 1. Hold-based payments

### Bid lifecycle

1. `POST /bids` creates a PaymentIntent with `capture_method: "manual"`
   (plus `description: "oneaboveall.org seat bid"`). The client confirms it
   with the Payment Element exactly as today.
2. Stripe sends `payment_intent.amount_capturable_updated` (status
   `requires_capture`). The webhook calls `recordBid` exactly as it does for
   `payment_intent.succeeded` today. `payment_intent.succeeded` stays
   handled too (idempotent on `paymentRef`), so a PaymentIntent created by
   the pre-change code, and the `succeeded` event fired by our own capture,
   are both safe.
3. On a recorded bid, **release** every unreleased bid in the round except:
   - the new top bid, and
   - the highest unreleased bid by a *different* bidder than the top
     (the "runner-up" — the fallback).
   So at most two holds are alive per round. A bidder who re-bids after
   being outbid has their older hold released.
4. At the round's daily close (16:00 ET, `nextDailyCloseAt`), the scheduler
   **settles** the round immediately — not after the 3h processing gap:
   - take the leader (top unreleased bid placed ≤ close); if it is already
     captured → settled;
   - otherwise capture it. Success → set `captured_at`. Definitive failure
     (card declined, PaymentIntent canceled/expired, invalid state) → set
     `refunded_at` (= released) and `capture_failed_at`, then repeat with
     the next unreleased bid (the runner-up). Transient errors (network,
     Stripe 5xx, rate limit) throw → retried on the next tick.
   - Once a bid is captured, release every other unreleased bid in the round.
   - If nothing could be captured, the round is empty-closed (champion
     stays, next round starts) exactly like a round with no bids.
5. The 3h gap and install are unchanged, except install only happens for a
   captured leader.

### Late webhooks

`recordBidAtomic` must reject a bid whose `placedAt` is at/after the round's
close time (`nextDailyCloseAt(round.startsAt)`), not only when `phase` is
not `bidding` — the phase stays `bidding` during the 3h gap, and today a
late webhook can displace (refund) the true winner. A rejected bid is
released.

### PaymentProvider

```ts
interface PaymentProvider {
  // Return the money / drop the hold. Must be idempotent and tolerate any
  // state: requires_capture → cancel; succeeded → refund; canceled → no-op.
  release(paymentRef: string): Promise<void>;
  // Collect a held bid. succeeded already → ok. requires_capture → capture
  // (Stripe idempotency key `capture-<pi>`). Anything else / card error →
  // { ok: false }. Transient errors throw.
  capture(paymentRef: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}
```

`refund` is removed; `FakePaymentProvider` records `releases`/`captures` and
can be told which refs fail to capture.

### Schema

`bids` gains nullable `captured_at`, `capture_failed_at`. `refunded_at`
keeps its DB name and TS name `refundedAt` but now means "released" (hold
cancelled or refunded); comments updated. `drizzle-kit push --force` adds
nullable columns non-interactively.

### Scheduler re-entrancy

`apps/api/src/scheduler.ts` must skip a tick while the previous one is still
running (captures make ticks slower than the 3s interval).

### Copy

Bid step: "Your card is only authorized now — you're charged only if you
hold the top bid when bidding closes at 4 PM ET. If you're outbid, the hold
is released (at the latest when the round closes)." History statuses:
`refunded` → shown as "Released".

## 2. Notifications (Resend)

Engine gains a `Notifier` interface (optional arg, no-op default):
`outbid({ bidderId, amountCents })`, `won({ bidderId, amountCents })`.
`recordBid` calls `outbid` for the displaced leader (not for a same-bidder
re-bid); settlement calls `won` for the captured winner. Notifier failures
are caught and logged — never break bookkeeping.

`apps/api` implements it with a plain `fetch` to
`https://api.resend.com/emails`, using `RESEND_API_KEY` and `EMAIL_FROM`
(default `oneaboveall <noreply@oneaboveall.org>`), looking up the user's
email. Unset key → log once and skip. Emails: "You've been outbid on
oneaboveall.org" (link back to the site), "You won the seat" (ask to upload
the photo if missing; art appears ~7 PM ET).

## 3. Attribution

- Web: on any page load, if the URL has `ref` or `utm_*`, store first-touch
  `{ ref, utmSource, utmMedium, utmCampaign, utmContent, landingAt }` in
  localStorage (never overwrite), and `POST /ref-visits { ref }` once per
  session (sessionStorage flag) when `ref` is present.
- API: `POST /ref-visits` increments a `ref_visits(ref pk, count)` row.
  Values sanitized: `^[A-Za-z0-9_.-]{1,64}$`, otherwise ignored (204).
- `users` gains nullable `ref`, `utm_source`, `utm_medium`, `utm_campaign`,
  `utm_content`, `attributed_at`. `PATCH /auth/attribution` sets them only
  if `attributed_at` is null (write-once first touch). The web app calls it
  once after it learns the visitor is signed in and has stored attribution.
- `POST /bids` copies the user's `ref`/utm into PaymentIntent metadata.

## 4. Admin (operator) API

`ADMIN_TOKEN` env; `Authorization: Bearer <token>`, constant-time compare;
unset token → every `/admin/*` route 404s.

- `GET /admin/stats` — per ref: visits, sign-ups, distinct bidders, distinct
  winners (captured bids), captured revenue; plus totals.
- `GET /admin/round` — current round: leader & runner-up (user id, name,
  email, amount, captured?, photo present?, socialUrl, characterRequest,
  sponsored).
- `GET /admin/photos/:userId` — the stored photo (for composing the art).
- `PATCH /admin/users/:id` — `{ sponsored?: boolean, clearSocialUrl?: true,
  clearPhoto?: true, name?: string }` moderation.

## 5. Photo privacy

`GET /photos/:userId` becomes owner-only (session user must equal
`:userId`); the operator uses the admin route. The public scene uses the
composed `scene.jpg`, never raw photos.

## 6. Public drama + sponsor label

- `users.sponsored boolean not null default false`.
- `/current-round` adds `leader: { name, sponsored } | null`,
  `champion: { name, sponsored }` and `recentBids: { name, amountCents,
  placedAt }[]` (last 5 bids in the round, newest first).
- `/scene` champion/retinue and `/leaderboard` rows add `sponsored`.
- Homepage shows "Leading: NAME" under the price (or "No bids yet"), and
  the sponsored label next to sponsored names in the hover card.
- Bid step notes the display name is shown publicly as leader.

## 7. OBS overlay

Static page `/overlay` — transparent background, compact panel: champion
name, current price, leader, countdown to 16:00 ET, `oneaboveall.org`.
Polls `/current-round` every 5s. Query `?compact=1` hides the bid feed.

## 8. Legal & consent

- Pages `/terms` (incl. "Payments: you pay only if you win", refunds,
  content policy, 18+, EU withdrawal-right waiver for immediately performed
  digital service, governing law Spain), `/privacy` (GDPR: controller
  Devvally, Spain, contact email; data: OAuth name/email, photo, social
  link, attribution, payments via Stripe; session cookie + localStorage;
  retention; rights; AEPD), both marked as drafts pending legal review in a
  repo doc, not on the page.
- Bid amount step: required checkbox "I'm 18 or older and agree to the
  Terms. I ask for the service to start immediately and understand I lose
  my right of withdrawal once I win the seat." `POST /bids` requires
  `acceptedTerms: true` and stores `users.terms_accepted_at` (first time).
- Small footer links (Terms · Privacy · contact) on the homepage; the
  sign-in overlay's dead "rules page" sentence links to `/terms`.

## 9. Link previews

`BaseLayout` gets `description`, Open Graph and Twitter card tags,
`og:image` → `/og.jpg` (1200×630 crop of `scene.jpg`), canonical
`https://oneaboveall.org/`, and a favicon.

## Out of scope

Lowering `MAX_BID_CENTS`, percentage increments (unneeded with holds),
external object storage (photos already sit on a PVC), Stripe statement
descriptor (dashboard setting).

## Deploy notes (owner actions)

- Stripe dashboard → webhook endpoint: add
  `payment_intent.amount_capturable_updated` (keep `payment_intent.succeeded`).
  **Without it no bid is ever recorded.**
- `prod.env`: `RESEND_API_KEY`, `EMAIL_FROM`, `ADMIN_TOKEN`.
- Resend: verify the `oneaboveall.org` domain (DNS records).
