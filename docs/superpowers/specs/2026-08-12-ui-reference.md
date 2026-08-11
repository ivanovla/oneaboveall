# UI Reference — Interactive Prototype

## Status

This spec doesn't describe new behavior — it designates [`design/prototype/one-above-all.dc.html`](../../../design/prototype/one-above-all.dc.html) (open directly in a browser; it's self-contained with `support.js` and `scene.png`) as the **canonical UX reference** for the whole product. From this point on, every screen, flow, copy string, and visual detail built for real should match this prototype unless a spec explicitly says otherwise. Where an earlier spec's UI assumptions conflict with the prototype, the prototype wins (see "Supersedes" below).

The prototype is a working interactive mock (React-based `dc-runtime`, not production code) — it's a reference for behavior and visual design, not a codebase to build on top of.

## What It Confirms From Existing Specs

- Deposit = 10% of the bid, capped at $1,000 — matches [auction-engine-design.md](2026-08-06-auction-engine-design.md)'s "fixed percentage, capped at $1000" with the percentage now pinned down.
- Bidding window countdown / payment window countdown, cascade-to-next-in-queue on missed payment, 3-round participation ban — all match the auction engine spec's day-cycle state machine.
- Retinue = last 8 champions by chronology, ranked "Retinue #1" (most recent) downward — matches [public-page-delivery-design.md](2026-08-06-public-page-delivery-design.md).
- Only the "Displace" button label is English; surrounding copy is otherwise unconstrained.

## New Decisions the Prototype Settles

- **International payment provider: Stripe.** Confirmed, not a placeholder. RU IPs default to YooKassa, everyone else defaults to Stripe, with a manual override control in the bid step.
- **No separate "personal account" page.** The whole authenticated flow (sign in → bid → queue status → pay balance → upload photo → pending/missed) is a single modal stepped over the scene, not a distinct dashboard route. This supersedes the earlier design-prompt's assumption of a full "личный кабинет" page — the modal-over-scene approach is simpler and keeps the "there's essentially nothing here" principle intact even while authenticated.
- **Per-person social link.** Each of the 9 people carries an optional outbound link (prototype uses Instagram) shown at the bottom of their hover card. Implies a profile field captured at some point in the winner flow (not yet specced where).
- **"Champions archive."** The consent copy references publishing the photo "on the homepage and in the champions archive" — implies past champions' photos are kept browsable somewhere beyond the leaderboard's stats-only view. Not yet specced as its own screen/data need — flagged as an open item below.
- **Leaderboard "rounds" count.** Each leaderboard row shows number of distinct reigns ("6 rounds"), not just cumulative days and total spent. This is a straightforward aggregate over `ReignHistory` (count of reigns per `occupant_id`), doesn't require new data beyond what the auction engine spec already tracks.

## Screen Inventory (as implemented in the prototype)

1. **Scene (home)** — full-bleed `scene.png`, 9 invisible circular hotspots positioned by `left%/top%`, hover/tap → tooltip card (name, rank badge, period, Held/Paid stats, social link). Top-right: theme toggle + Leaderboard button. Bottom: price, "Displace" button, bidding-window countdown.
2. **Auth** — Google / Apple sign-in.
3. **Bid** — must-beat price, minimum, bid input, computed deposit, provider picker (YooKassa/Stripe) with geo-detected default, place-deposit CTA.
4. **Lead (queued)** — confirms bid accepted, shows deposit held + time until snapshot.
5. **Pay** — remaining balance due, payment-window countdown, pay CTA.
6. **Upload** — photo dropzone, consent checkbox (submit disabled until checked).
7. **Pending** — "scene is updating" waiting state.
8. **Missed** — payment window closed, deposit forfeited, ban notice, next-eligible-date.
9. **Leaderboard** — ranked list: name, rounds count, total spent, cumulative days.

## Visual System

Dark void background (`#070603`) with a warm gold accent (`#c9a45c`) on cream text (`#f0e7d6`); a light theme variant is included and toggled at runtime. Serif display type (Cormorant Garamond) for numbers/headlines, sans (Manrope) for body/labels. Panels use heavy blur + translucent dark fill. These tokens should carry directly into the real implementation's design system rather than being reinvented.

## Open Items

- Where the social-link field and photo get captured in the winner flow isn't specced yet (likely part of the upload step, alongside consent).
- The "champions archive" as a distinct browsable surface isn't specced — decide whether it's just the existing leaderboard/hover data, or a real separate gallery.
