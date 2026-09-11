import type { Scene, Person, LeaderboardRow } from "./types";
import type { ApiSceneResponse, ApiRetinueMember, ApiLeaderboardRow } from "./apiTypes";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function formatDurationLabel(ms: number): string {
  return `${Math.floor(ms / MS_PER_DAY)}d`;
}

// Renders an offending value for an error message. Only ever called on a
// payload already known to be wrong.
function describeValue(value: unknown): string {
  if (typeof value === "string" || (typeof value === "object" && value !== null)) {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      // Circular structure, a BigInt, … — the shape is already known to be
      // wrong; don't let describing it throw a second, more confusing error.
      return "[unserialisable value]";
    }
  }
  // Numbers (including NaN, which JSON.stringify flattens to "null"),
  // booleans, null and undefined all read more clearly this way.
  return String(value);
}

/**
 * Rejects a structurally wrong payload. Every adapter below calls this rather
 * than coercing bad input into a partially-valid object.
 *
 * That is load-bearing rather than merely tidy. `new Date("not a date")` does
 * not throw — it yields an `Invalid Date`, which survives every assignment in
 * this file and only blows up much later, inside `Scene.astro`'s
 * `Intl.DateTimeFormat.format()`, as a `RangeError`. A malformed API body
 * would then crash the build from a file that has no fallback logic at all,
 * sailing straight past the "malformed response body" catch in
 * pages/index.astro that exists to handle exactly this — and past the
 * REQUIRE_LIVE_DATA gate that decides whether a bad payload is fatal.
 * Failing loudly and early, right where the payload is first inspected, is
 * what keeps that decision in the one place that makes it.
 */
function malformed(what: string, received: unknown): never {
  throw new Error(`Malformed API payload: ${what} (received ${describeValue(received)})`);
}

function parseApiDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    malformed(`${field} is not a parseable date`, value);
  }
  return date;
}

function adaptRetinueMember(api: ApiRetinueMember, index: number): Person {
  const startedAt = parseApiDate(api.startedAt, `retinue[${index}].startedAt`);
  const endedAt = parseApiDate(api.endedAt, `retinue[${index}].endedAt`);

  return {
    occupantId: api.occupantId,
    name: api.occupantId,
    priceCents: api.priceCents,
    since: startedAt,
    heldLabel: formatDurationLabel(endedAt.getTime() - startedAt.getTime()),
  };
}

export function adaptScene(api: ApiSceneResponse): Scene | null {
  // A genuinely absent champion is a valid state, not a malformed payload:
  // a freshly bootstrapped engine has nobody in the seat yet. The caller
  // decides what an empty scene means; this stays a clean `null`.
  if (!api.champion) return null;

  if (!Array.isArray(api.retinue)) {
    malformed("retinue is not an array", api.retinue);
  }

  return {
    champion: {
      occupantId: api.champion.occupantId,
      name: api.champion.occupantId,
      priceCents: api.champion.priceCents,
      since: parseApiDate(api.champion.since, "champion.since"),
      // Deliberately empty: the champion's reign is still running, so the
      // time held is computed live from `since` (see types.ts) and never
      // baked into a static label. Scene.astro branches on isChampion and
      // ignores this field for them.
      heldLabel: "",
    },
    retinue: api.retinue.map(adaptRetinueMember),
  };
}

export function adaptLeaderboardRow(api: ApiLeaderboardRow): LeaderboardRow {
  // Same reasoning as the date checks above, one layer down: a non-numeric
  // duration doesn't throw on its own, it renders as the string "NaNd" in
  // the leaderboard overlay.
  if (!Number.isFinite(api.totalDurationMs)) {
    malformed(`totalDurationMs for "${api.occupantId}" is not a finite number`, api.totalDurationMs);
  }

  return {
    occupantId: api.occupantId,
    name: api.occupantId,
    rounds: api.rounds,
    totalSpentCents: api.totalSpentCents,
    totalDurationLabel: formatDurationLabel(api.totalDurationMs),
  };
}
