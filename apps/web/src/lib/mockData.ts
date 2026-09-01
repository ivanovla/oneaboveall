import type { Scene, Person, LeaderboardRow } from "./types";

// Source data transcribed from design/prototype/one-above-all.dc.html's
// `PEOPLE` / `BOARD` JS arrays (lines ~269-290). All money values there are
// whole dollars ("paid":"$4,210"); here they become integer cents
// (priceCents: 421_000), matching the shape of apps/engine's amounts.
//
// The prototype has no notion of a build-time-fixed "now" — its countdown
// runs off `Date.now()` in the browser and its "held"/"period" strings are
// just static demo copy. To make this mock data deterministic we fix a
// single reference "now" and derive every date from it:
const REFERENCE_NOW = new Date("2026-08-09T14:20:00Z");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

// The champion's reign is still ongoing, so its "time held" must be
// computed live client-side as `now - since` (see types.ts). For the mock
// data to render that computation as "1d 4h" — the prototype's demo
// held value for Mark Vilensky — `since` is derived by subtracting that
// duration from REFERENCE_NOW, rather than parsing the prototype's
// decorative "since Aug 9, 2:20 PM" period string (which isn't
// self-consistent with a 1d4h-old reign anyway).
const championSince = new Date(REFERENCE_NOW.getTime() - (1 * ONE_DAY_MS + 4 * ONE_HOUR_MS));

// Retinue members' reigns have already ended, so their "since" is just a
// historical start date (used for the "since"/period line) and never
// recomputed against REFERENCE_NOW. The prototype's `period` field only
// gives a day ("Held the seat on Aug 8"), not a time, so each retinue
// `since` reuses the champion's time-of-day (14:20 UTC) for a plausible,
// consistent-looking timestamp. Year 2026 is assumed throughout, matching
// REFERENCE_NOW. `heldLabel` is transcribed verbatim from the prototype's
// `held` field ("1d" for every retinue entry in PEOPLE).
function retinueSince(augustDay: number): Date {
  return new Date(Date.UTC(2026, 7, augustDay, 14, 20, 0));
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
    since: retinueSince(8),
    heldLabel: "1d",
    instagramUrl: INSTAGRAM_URL,
  },
  {
    occupantId: "osei-adjei",
    name: "Osei Adjei", // Retinue #2
    priceCents: 364_000, // "$3,640"
    since: retinueSince(7),
    heldLabel: "1d",
    instagramUrl: INSTAGRAM_URL,
  },
  {
    occupantId: "arthur-lemeshev",
    name: "Arthur Lemeshev", // Retinue #3
    priceCents: 310_000, // "$3,100"
    since: retinueSince(6),
    heldLabel: "1d",
    instagramUrl: INSTAGRAM_URL,
  },
  {
    occupantId: "ivan-dorn",
    name: "Ivan Dorn", // Retinue #4
    priceCents: 287_000, // "$2,870"
    since: retinueSince(5),
    heldLabel: "1d",
    instagramUrl: INSTAGRAM_URL,
  },
  {
    occupantId: "felix-lang",
    name: "Felix Lang", // Retinue #5
    priceCents: 240_000, // "$2,400"
    since: retinueSince(4),
    heldLabel: "1d",
    instagramUrl: INSTAGRAM_URL,
  },
  {
    occupantId: "y-kimura",
    name: "Y. Kimura", // Retinue #6
    priceCents: 215_000, // "$2,150"
    since: retinueSince(3),
    heldLabel: "1d",
    instagramUrl: INSTAGRAM_URL,
  },
  {
    occupantId: "timur-aslanov",
    name: "Timur Aslanov", // Retinue #7
    priceCents: 198_000, // "$1,980"
    since: retinueSince(2),
    heldLabel: "1d",
    instagramUrl: INSTAGRAM_URL,
  },
  {
    occupantId: "paul-renier",
    name: "Paul Renier", // Retinue #8
    priceCents: 172_000, // "$1,720"
    since: retinueSince(1),
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

// Matches the prototype's demo countdown of 6h41m12s
// (state.left = 6*3600 + 41*60 + 12) measured from REFERENCE_NOW.
export const mockBiddingWindowClosesAt = new Date("2026-08-09T21:01:12Z");
