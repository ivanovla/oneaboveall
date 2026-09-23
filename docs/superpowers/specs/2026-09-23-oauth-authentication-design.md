# OAuth Authentication Design

**Goal:** Real Google and Apple sign-in for oneabobeall.org, giving every bidder a persistent
account instead of an anonymous per-browser id — the foundation the personal-account dashboard
(Plan B) and the live auction page (Plan C) both depend on.

## Status: Plan A of a 3-plan decomposition

The user redirected the frontend work from "wire Stripe into the existing modal-over-scene"
(the shape assumed by `docs/superpowers/specs/2026-08-12-ui-reference.md`) to a full personal
account model: sign in → land in a dashboard → the auction/bidding page and the deposit-payment
flow live inside it. That's three separable pieces, built in this order:

- **Plan A (this spec): OAuth authentication.** Nothing else can require a real identity until
  this exists.
- **Plan B: personal account dashboard shell.** A new route, gated on being signed in, with
  navigation — no auction content yet.
- **Plan C: the auction/bidding page inside the dashboard.** Live round state, the Stripe
  Elements deposit form (what the user calls "пополнение баланса" — confirmed to just be Join,
  not a separate wallet/balance feature — no new money-holding concept, no new engine schema
  beyond what Plan A itself adds), free bid submission.

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
6. Create a `sessions` row, set the cookie, redirect to `/account` (Plan B's dashboard route;
   a placeholder redirect target until Plan B exists — see Testing below).

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

## Out of Scope (explicitly)

- Account linking/merging across providers.
- The dashboard UI itself (Plan B) and the auction page (Plan C).
- Any change to `apps/web`'s public scene page.
- Rate limiting / bot protection on the auth routes (a reasonable follow-up, not required to
  ship this).
