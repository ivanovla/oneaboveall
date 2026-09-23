# Personal Account & Live Auction Frontend Design

**Goal:** Real Google/Apple sign-in, a personal-account dashboard, and a live auction page
inside it (real-time price, Stripe-backed deposit "Join", free bid submission) — built and
shipped together in one branch, per the user's explicit call to keep this simple rather than
split into three separately-branched plans.

## Status: one consolidated design, three logical sections

The user redirected the frontend work from "wire Stripe into the existing modal-over-scene"
(the shape assumed by `docs/superpowers/specs/2026-08-12-ui-reference.md`) to a full personal
account model: sign in → land in a dashboard → the auction/bidding page and the deposit-payment
flow live inside it. That decomposes into three logical pieces — OAuth, the dashboard shell,
the auction page — kept as one design doc and one implementation plan (originally scoped as
three separate branches/plans; consolidated on the user's instruction: "делай все в 1 общей
ветке не усложняй"):

- **Section A: OAuth authentication.** Nothing else can require a real identity until this
  exists.
- **Section B: personal account dashboard shell.** A new route, gated on being signed in, with
  navigation.
- **Section C: the auction/bidding page inside the dashboard.** Live round state, the Stripe
  Elements deposit form (what the user calls "пополнение баланса" — confirmed to just be Join,
  not a separate wallet/balance feature — no new money-holding concept, no new engine schema
  beyond what Section A itself adds), free bid submission.

**The public scene page (`apps/web/src/pages/index.astro`) does not change.** It stays exactly
as static and build-time-only as it is today — confirmed explicitly by the user ("главная
страница должна быть просто статикой"). The "Displace" button becomes a plain link to the
sign-in flow (or straight to the dashboard, if already signed in) rather than opening an
in-page overlay that fetches live data. The static-delivery invariant in
`docs/superpowers/specs/2026-08-06-public-page-delivery-design.md` is therefore **not** violated
by this plan the way the engine+API plan's live routes already are for the auction endpoints —
this plan's new routes live entirely on new, separate, inherently-dynamic pages.

## Global Constraints

- Money is always integer cents (unchanged — this plan touches no money logic).
- `users.id` becomes the engine's `bidderId` directly — no new mapping table, no change to
  `apps/engine`'s schema (its `bidderId` columns are already plain `text`, opaque by design).
- Session tokens are opaque, server-validated, never JWTs the client can decode or forge.
- Two OAuth accounts (one Google, one Apple) for the same real person are treated as two
  separate `users` rows. No account linking/merging in this plan — explicitly out of scope.

## Architecture

New routes on `apps/api` (the only live service in this project):

- `GET /auth/google` — redirects to Google's OAuth consent screen.
- `GET /auth/google/callback` — Google's redirect target (its protocol uses a GET with a
  `code` query param).
- `GET /auth/apple` — redirects to Apple's consent screen.
- `POST /auth/apple/callback` — Apple's redirect target (Sign in with Apple's protocol
  mandates a POST here, unlike Google's GET).
- `POST /auth/logout` — clears the session.
- `GET /auth/me` — returns the current session's user (or 401), the primitive every other
  page/route uses to check "who is signed in."

**OAuth library:** `openid-client` (a mature, spec-compliant OIDC client), not a hand-rolled
implementation. Both Google and Apple are OIDC-compliant, so one library covers both providers.
Hand-rolling this is explicitly rejected — PKCE, CSRF `state` validation, and Apple's rotating
JWT signing keys are exactly the kind of security-critical plumbing a maintained library exists
to get right once.

**Data model** — two new tables (in `apps/engine/src/db/schema.ts`, alongside the existing
auction tables, since that's where the Postgres client already lives):

```
users:    id (uuid, pk), provider ("google"|"apple"), providerId (text), email (text),
          name (text), createdAt (timestamp)
sessions: token (text, pk, opaque random), userId (uuid, fk -> users.id),
          expiresAt (timestamp), createdAt (timestamp)
```

Unique constraint on `(provider, providerId)` on `users` — this is what makes "does this
Google/Apple account already have a users row" a single indexed lookup, and (combined with a
claim-before-act insert, matching this codebase's established discipline) what makes a
double-submitted OAuth callback safe.

**Session delivery:** an httpOnly, Secure, SameSite=Lax cookie carrying only the opaque
`sessions.token` — never any user data client-side. `GET /auth/me` and any future
authenticated route look the token up against `sessions`, joined to `users`.

**Apple's first-login-only profile data:** Apple includes `email` and `name` in the callback
payload only on the user's very first authorization for this app; every subsequent sign-in
omits them (returning only the stable `sub` identifier). The callback handler must persist
`email`/`name` into the `users` row on creation and never expect Apple to resend them — a
returning user's callback updates nothing but confirms/reuses the existing row via
`(provider, providerId)`.

## OAuth Flow

1. User clicks "Sign in with Google" (or Apple) → browser hits `GET /auth/{provider}`.
2. Route generates a `state` (CSRF) and, for Google, a PKCE code verifier; stores them
   server-side (session-less at this point — a short-lived signed cookie, since no user
   session exists yet); redirects to the provider's consent screen.
3. Provider redirects back to the callback route with an authorization code (Google: query
   param; Apple: POST body).
4. Callback route verifies `state`, exchanges the code for tokens via `openid-client`,
   extracts `sub`/`email`/`name` from the verified ID token.
5. Upsert: look up `users` by `(provider, providerId)`. If found, done. If not, insert a new
   row (email/name captured now — see the Apple note above).
6. Create a `sessions` row, set the cookie, redirect to `/account` (Section B's dashboard
   route, built in this same plan).

## Error Handling

- Invalid/missing `state` → reject with a generic error page, no partial session created.
- Provider returns an error (user declined consent, etc.) → redirect back to the sign-in
  entry point with a visible "sign-in was cancelled" message, not a raw error dump.
- Token exchange or ID-token verification failure (network error, bad signature, expired code)
  → same generic error page; log the real cause server-side, never expose provider internals
  to the client.
- `GET /auth/me` with no cookie, an unknown token, or an expired session → 401, not a crash.

## Testing

- Unit tests around the `users`/`sessions` upsert logic (new-user creation, returning-user
  match, the unique-constraint-driven idempotency of a double callback) using the same
  Vitest + real local Postgres pattern already established for `apps/engine`.
- `apps/api` route tests mocking `openid-client`'s token exchange (no real network calls in
  the automated suite, matching how `apps/api`'s Stripe tests mock the Stripe SDK).
- Manual, pre-merge verification against real Google and Apple test credentials — the user
  provides real `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and
  `APPLE_TEAM_ID`/`APPLE_KEY_ID`/`APPLE_SERVICES_ID`/the `.p8` private key once they've set up
  the Google Cloud Console project and Apple Developer Program enrollment; this plan is built
  and unit-tested against placeholder env vars in the meantime, the same pattern used for
  Stripe in the prior plan.

## Section B: Personal Account Dashboard Shell

A new Astro route, `apps/web/src/pages/account.astro` (or a directory `account/index.astro` if
sub-routes are needed — `account/auction.astro` for Section C). Server-rendered per request
(not static — it must check the session cookie before rendering anything), redirecting to the
sign-in entry point if `GET /auth/me` (called server-side, during the page's own render) returns
401.

Layout: reuses `apps/web/src/styles/tokens.css` as-is — `--void` background, `--gold` accent,
Cormorant Garamond for numbers/headings, Manrope for body text, the same panel/line treatment
already used throughout `AuctionFlow.tsx`'s overlays. A persistent header (site mark, sign-out)
and a simple nav (Auction, Leaderboard — reusing the existing leaderboard screen's content) —
no attempt to invent a new visual language; the dashboard is the same design system as the
public scene, just in a normal page layout instead of a full-bleed photo with overlays.

## Section C: Auction / Bidding Page

`apps/web/src/pages/account/auction.astro` (or equivalent), the dashboard's main content.
Fetches initial state server-side on render (current round info, whether this signed-in user
has already joined), then a client-side island (a trimmed-down descendant of the existing
`AuctionFlow.tsx` patterns, not a rewrite from scratch) takes over for the live parts:

- Polls `GET /current-round` every 5–10s while the tab is visible (paused via the
  `document.visibilityState`/`visibilitychange` check — see Performance & Scale) to keep price,
  phase, and the bidding-window countdown live.
- If this user hasn't joined the current round: a card showing the fixed deposit amount and a
  "Join" button, which calls `POST /rounds/:id/join`, then renders Stripe Elements
  (`@stripe/stripe-js` + `@stripe/react-stripe-js`) using the returned `clientSecret` to collect
  and confirm the card. On confirmation, polls `GET /current-round` (or a dedicated
  "have I joined" signal — see Testing below) until the webhook-driven join is reflected, since
  confirmation on the client and the server-side `roundParticipants` row landing are not the
  same instant.
- If this user has joined: a bid input + "Place bid" button, calling `POST /bids` — no payment
  step, callable repeatedly for free, matching the engine's actual round rules.
- No manual "Pay remainder" step and no separate "queue" screen — the engine charges the winner
  automatically off-session, so there's nothing for the winner to click. A simple, low-key
  "you're the current top bid" indicator is enough; there's no snapshot-immediately-after-bid
  concept the way the mock UI's old "Lead" screen implied (that screen's meaning belonged to
  the earlier per-bid deposit model this project has already moved past).
- The old mock's `upload`/`pending`/`missed` screens are untouched — they belong to the
  still-unbuilt face-generation pipeline, explicitly out of scope for every plan so far.

## Performance & Scale

The user asked explicitly for this to handle many concurrent users — noted here because it
changes a few defaults from what a "just make it work" version would ship with:

- **Cache `getCurrentRoundInfo` briefly in `apps/api`.** With many browser tabs each polling
  `GET /current-round` every 5–10s, an in-process cache with a ~1–2s TTL in front of the
  engine call collapses concurrent pollers within that window into a single DB round-trip,
  instead of one `getCurrentReign`/`getLatestRound`/`getQueueLeader` sequence per request. Cheap
  to add, meaningfully cuts DB load under many simultaneous viewers, and doesn't need to be a
  shared/distributed cache — a short enough TTL makes a per-process cache sufficient even once
  `apps/api` runs as multiple instances behind a load balancer (a deployment-layer concern, not
  this plan's — but the code must stay safe to run as multiple stateless instances, so nothing
  here should rely on in-process cache staying consistent *across* instances, only within one).
- **Pause client-side polling when the tab isn't visible.** `document.visibilityState` — stop
  the interval on `hidden`, resume (and immediately re-fetch once) on `visible`. A large fraction
  of "many concurrent users" in practice means many open-but-backgrounded tabs; this alone cuts
  a meaningful share of the polling load for free.
- **Dashboard/auction pages stay a thin shell, not a full SSR re-render per poll.** Only the
  initial page load is server-rendered (for the session check and first paint); every
  subsequent update is a plain client-side fetch against `apps/api`'s JSON routes, not a
  re-render of the Astro page. This keeps the marginal cost of "one more active user" limited to
  small JSON responses and the existing (already load-tested-in-design)
  `placeBidAtomic`/`joinRound` DB paths, not page-rendering work.
- **No change needed to the engine's existing concurrency handling.** `placeBidAtomic`'s
  SERIALIZABLE-with-retry pattern is already the documented, deliberate answer to many
  simultaneous bidders contending for the same round's leader slot — this plan adds callers, not
  new contention shape.
- **Session lookups stay a single indexed read.** `sessions.token` is the primary key; `GET
  /auth/me` and any future session check is already O(1) against the index, no additional
  design needed there.
- **Horizontal scaling itself is explicitly a deployment-plan concern**, not this one — this
  plan is scoped to writing code that is safe to run as multiple instances (no reliance on
  in-process-only state for correctness), not to actually standing up multiple instances or a
  load balancer.

## Out of Scope (explicitly)

- Account linking/merging across providers.
- Any change to `apps/web`'s public scene page (`index.astro` stays fully static).
- The `upload`/`pending`/`missed` face-pipeline screens.
- Rate limiting / bot protection on the auth or bidding routes (a reasonable follow-up, not
  required to ship this).
- Actually standing up multiple `apps/api` instances / a load balancer (deployment-plan work;
  this plan only avoids making that harder later).
