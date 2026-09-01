import type { Scene, Person, LeaderboardRow } from "./types";

// Source data transcribed from design/prototype/one-above-all.dc.html's
// `PEOPLE` / `BOARD` JS arrays (lines ~269-290). All money values there are
// whole dollars ("paid":"$4,210"); here they become integer cents
// (priceCents: 421_000), matching the shape of apps/engine's amounts.
//
// The prototype has no notion of a build-time-fixed "now" — its countdown
// runs off `Date.now()` in the browser and its "held"/"period" strings are
// just static demo copy. To make this mock data deterministic we fix a
// single reference "now" and derive every date from it.
//
// Think of `mockReferenceNow` as the instant this whole frozen snapshot was
// taken: every other date here (reign starts, window close times) is an
// offset from it, and every consumer measures durations against it rather
// than against the real wall clock. That is what keeps the numbers on screen
// stable — a snapshot anchored to `Date.now()` goes stale within hours and
// then renders `00:00:00` forever (which is exactly what the previous
// 2026-08-09 anchor had already decayed into).
//
// The date itself is deliberately ~9 months past the branch's own authoring
// date: nothing in the UI ever prints a year (the tooltip formatters emit
// "Jun 1, 2:20 PM"), so a future anchor is indistinguishable on screen, but
// it keeps any date-sensitive reading — including a hypothetical future
// consumer that *does* compare against the real clock — pointing forward for
// a full review/merge cycle rather than backwards.
export const mockReferenceNow = new Date("2027-06-01T14:20:00Z");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const ONE_SECOND_MS = 1000;

// The champion's reign is still ongoing, so its "time held" keeps ticking up
// (see types.ts). For it to render as "1d 4h" — the prototype's demo held
// value for Mark Vilensky — `since` is derived by subtracting that duration
// from `mockReferenceNow`, rather than parsing the prototype's decorative
// "since Aug 9, 2:20 PM" period string (which isn't self-consistent with a
// 1d4h-old reign anyway).
const championSince = new Date(
  mockReferenceNow.getTime() - (1 * ONE_DAY_MS + 4 * ONE_HOUR_MS),
);

// Retinue members' reigns have already ended, so their "since" is just a
// historical start date (used for the "since"/period line) and never
// recomputed. The prototype's `period` field only gives a day ("Held the
// seat on Aug 8"), not a time, so each retinue `since` is a whole number of
// days before `mockReferenceNow` — which reuses its 14:20 UTC time-of-day
// and, unlike the previous hard-coded August 2026 dates, stays consistent
// with the reference anchor whenever that anchor moves. `daysAgo` 1-8 maps
// onto the prototype's Aug 8 … Aug 1 relative to its own Aug 9 "now".
// `heldLabel` is transcribed verbatim from the prototype's `held` field
// ("1d" for every retinue entry in PEOPLE).
function retinueSince(daysAgo: number): Date {
  return new Date(mockReferenceNow.getTime() - daysAgo * ONE_DAY_MS);
}

const INSTAGRAM_URL = "https://instagram.com";

const champion: Person = {
  occupantId: "mark-vilensky",
  name: "Mark Vilensky",
  priceCents: 421_000, // "$4,210"
  since: championSince,
  heldLabel: "", // unused for the champion — held time is computed from `since`
  instagramUrl: INSTAGRAM_URL,
};

const retinue: Person[] = [
  {
    occupantId: "daniel-crowe",
    name: "Daniel Crowe", // Retinue #1
    priceCents: 398_000, // "$3,980"
    since: retinueSince(1),
    heldLabel: "1d",
    instagramUrl: INSTAGRAM_URL,
  },
  {
    occupantId: "osei-adjei",
    name: "Osei Adjei", // Retinue #2
    priceCents: 364_000, // "$3,640"
    since: retinueSince(2),
    heldLabel: "1d",
    instagramUrl: INSTAGRAM_URL,
  },
  {
    occupantId: "arthur-lemeshev",
    name: "Arthur Lemeshev", // Retinue #3
    priceCents: 310_000, // "$3,100"
    since: retinueSince(3),
    heldLabel: "1d",
    instagramUrl: INSTAGRAM_URL,
  },
  {
    occupantId: "ivan-dorn",
    name: "Ivan Dorn", // Retinue #4
    priceCents: 287_000, // "$2,870"
    since: retinueSince(4),
    heldLabel: "1d",
    instagramUrl: INSTAGRAM_URL,
  },
  {
    occupantId: "felix-lang",
    name: "Felix Lang", // Retinue #5
    priceCents: 240_000, // "$2,400"
    since: retinueSince(5),
    heldLabel: "1d",
    instagramUrl: INSTAGRAM_URL,
  },
  {
    occupantId: "y-kimura",
    name: "Y. Kimura", // Retinue #6
    priceCents: 215_000, // "$2,150"
    since: retinueSince(6),
    heldLabel: "1d",
    instagramUrl: INSTAGRAM_URL,
  },
  {
    occupantId: "timur-aslanov",
    name: "Timur Aslanov", // Retinue #7
    priceCents: 198_000, // "$1,980"
    since: retinueSince(7),
    heldLabel: "1d",
    instagramUrl: INSTAGRAM_URL,
  },
  {
    occupantId: "paul-renier",
    name: "Paul Renier", // Retinue #8
    priceCents: 172_000, // "$1,720"
    since: retinueSince(8),
    heldLabel: "1d",
    instagramUrl: INSTAGRAM_URL,
  },
];

export const mockScene: Scene = { champion, retinue };

// Transcribed from the prototype's BOARD array. Note BOARD (8 rows) covers
// the champion plus 7 of the 8 retinue members — Ivan Dorn (Retinue #4)
// does not appear on the prototype's leaderboard either, so that omission
// is preserved here rather than "fixed".
export const mockLeaderboard: LeaderboardRow[] = [
  {
    occupantId: "mark-vilensky",
    name: "Mark Vilensky",
    rounds: 6,
    totalSpentCents: 1_840_000, // "$18,400 total"
    totalDurationLabel: "11d",
  },
  {
    occupantId: "osei-adjei",
    name: "Osei Adjei",
    rounds: 5,
    totalSpentCents: 1_490_000, // "$14,900"
    totalDurationLabel: "7d",
  },
  {
    occupantId: "daniel-crowe",
    name: "Daniel Crowe",
    rounds: 4,
    totalSpentCents: 1_230_000, // "$12,300"
    totalDurationLabel: "5d",
  },
  {
    occupantId: "felix-lang",
    name: "Felix Lang",
    rounds: 3,
    totalSpentCents: 810_000, // "$8,100"
    totalDurationLabel: "4d",
  },
  {
    occupantId: "y-kimura",
    name: "Y. Kimura",
    rounds: 3,
    totalSpentCents: 745_000, // "$7,450"
    totalDurationLabel: "3d",
  },
  {
    occupantId: "arthur-lemeshev",
    name: "Arthur Lemeshev",
    rounds: 2,
    totalSpentCents: 620_000, // "$6,200"
    totalDurationLabel: "2d",
  },
  {
    occupantId: "timur-aslanov",
    name: "Timur Aslanov",
    rounds: 2,
    totalSpentCents: 500_000, // "$5,000"
    totalDurationLabel: "2d",
  },
  {
    occupantId: "paul-renier",
    name: "Paul Renier",
    rounds: 1,
    totalSpentCents: 172_000, // "$1,720"
    totalDurationLabel: "1d",
  },
];

export const mockCurrentPriceCents = 421_000; // matches the champion's priceCents

// Both window-close timestamps are derived from `mockReferenceNow` rather
// than hard-coded, so bumping the anchor moves them with it and the two
// countdowns can never silently decay to `00:00:00` again.

// Matches the prototype's demo countdown of 6h41m12s
// (state.left = 6*3600 + 41*60 + 12) measured from the reference "now".
export const mockBiddingWindowClosesAt = new Date(
  mockReferenceNow.getTime() + 6 * ONE_HOUR_MS + 41 * ONE_MINUTE_MS + 12 * ONE_SECOND_MS,
);

// Matches the prototype's demo payment countdown of 3h12m
// (state.payLeft = 3*3600 + 12*60) measured from the reference "now".
// Previously the pay screen invented its own window from `Date.now()` at
// mount; it now reads from the same frozen snapshot as everything else.
export const mockPaymentWindowClosesAt = new Date(
  mockReferenceNow.getTime() + 3 * ONE_HOUR_MS + 12 * ONE_MINUTE_MS,
);
