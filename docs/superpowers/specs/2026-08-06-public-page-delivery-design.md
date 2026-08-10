# Public Page — Composition & Delivery Design

## Context

This spec covers the public generative page: what the composite scene shows, and how it's delivered so the page opens instantly. It builds on [2026-08-06-auction-engine-design.md](2026-08-06-auction-engine-design.md) — specifically the `on_champion_installed` event and the fact that a champion changes at most once every 24 hours (a round), while a leading bid within a round's 12h bidding window can change more often.

Out of scope here: the actual face-generation/compositing technique (deferred — the user is validating that by hand first), OAuth, payments, and the auction domain logic itself.

## Scene Composition

The page shows one cinematic composite image: the current champion elevated in the center, surrounded by a fixed 8-person retinue.

- **Retinue = the last 8 champions in chronological order** (most recent reigns before the current one), not the 8 who held the spot longest. The retinue reshuffles every time the champion changes: the outgoing champion joins the retinue, the oldest retinue member drops off.
- The full scene (all 9 faces) is regenerated on every champion change — triggered by `on_champion_installed`. This is the only event that touches the image itself.
- Hovering any of the 9 people shows a stats widget. Per person, the data needed is: identity/photo, `since` (reign start), and for retinue members (whose reign is over) a fixed `duration`; for the current champion, duration is not stored — it's computed client-side as `now - since`, so it keeps counting up in the browser with zero server involvement.

## Delivery Architecture

Fully static, no live/dynamic endpoint. Two independent triggers cause a rebuild, at different granularities:

1. **Champion change** (`on_champion_installed`, ≤ once/day) — full pipeline run: new composite image + updated retinue data, published under a content hash. The HTML is rebuilt to reference the new hashed asset URLs.
2. **New leading bid** (can happen many times during a round's 12h bidding window) — the composite image does *not* change; only the price/timer text on the "Сместить" button changes. This is a cheap template rebuild (no image pipeline involved) that re-publishes the small HTML shell.

Both cases produce a fully static HTML page pointing at immutable, content-hashed image/data assets, published to a CDN with standard global edge caching (no region-specific content — this was evaluated and rejected in favor of ordinary edge replication, since there's no legal/reachability reason found for a separate delivery path, unlike payments). Because assets are content-hashed and immutable, there's no cache-invalidation race: old assets simply become unreferenced and expire naturally; the only thing that needs a fast-propagating update is the small HTML shell itself.

Everything time-based shown on the page (bidding-window close time, payment-phase deadline) is baked in as an absolute timestamp and rendered client-side ("closes in Xh Ym") — again, no server push needed, since the client can always compute an offset from its own clock against a static deadline.

## Rebuild Triggers — Summary

| Event | Frequency | What changes | Cost |
|---|---|---|---|
| New leading bid | up to several times per 12h bidding window | price/timer text in HTML shell | cheap template render |
| Champion installed | ≤ once per 24h | full composite image (9 faces) + retinue data + HTML | full pipeline run (manual/external for now) |

## Open Questions / Deferred

- The face-compositing technique itself (models, prompts, consistency across regenerations) — explicitly deferred; the user is validating this by hand before it's specced.
- Photo upload + consent capture UI, and how the pipeline is actually invoked — belongs to a separate subsystem spec.
