// First-touch streamer attribution, browser side (launch-readiness spec §3).
//
// A streamer shares https://oneaboveall.org/?ref=<their code> (optionally
// with utm_* tags). Whoever lands through it may only sign in and bid days
// later, from a bare URL — so the tags are kept in localStorage at landing
// and handed to the API once the visitor is known:
//
//  1. captureAttribution() — on every page load (homepage and the legal
//     pages, never the OBS overlay, which streamers load all day long and
//     would otherwise count as endless visits): store the tags the first
//     time any are present, never overwriting an earlier touch, and POST
//     /ref-visits once per browser session when a ref is present.
//  2. sendAttributionIfNeeded() — called by AuctionFlow once it learns the
//     visitor is signed in: PATCH /auth/attribution once, then remember it
//     was sent. The server is write-once as well, so a repeat is harmless.
//
// Every storage access is wrapped: localStorage/sessionStorage throw in
// some private modes and with blocked site data, and attribution is never
// worth breaking the page over. Values are normalized here into the shape
// the API accepts (^[A-Za-z0-9_.-]{1,64}$ — see normalizeAttributionValue);
// the API still validates and drops anything else.

export const ATTRIBUTION_STORAGE_KEY = "oneaboveall:attribution";
export const REF_VISIT_SESSION_KEY = "oneaboveall:ref-visit-sent";

export type StoredAttribution = {
  ref?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  landingAt: string;
  // Set once PATCH /auth/attribution has succeeded for this browser.
  sentAt?: string;
};

const PARAMS: [param: string, field: keyof Omit<StoredAttribution, "landingAt" | "sentAt">][] = [
  ["ref", "ref"],
  ["utm_source", "utmSource"],
  ["utm_medium", "utmMedium"],
  ["utm_campaign", "utmCampaign"],
  ["utm_content", "utmContent"],
];

// The API's limit (engine/domain/attribution.ts).
const MAX_VALUE_LENGTH = 64;

// Brings a raw tag into the shape the API accepts, so a hand-typed link
// still counts instead of being silently dropped server-side — which would
// matter more than it looks: the stored first touch is write-once, and
// sendAttributionIfNeeded marks it sent even when the server dropped every
// value, so a tag that doesn't survive sanitization is lost for good.
// Streamers write things like utm_campaign=launch day: trim, turn
// whitespace into "-", drop every character outside [A-Za-z0-9_.-], and
// cut to 64. Null when nothing usable is left.
export function normalizeAttributionValue(raw: string): string | null {
  const value = raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9_.-]/g, "")
    .slice(0, MAX_VALUE_LENGTH);
  return value || null;
}

export function readStoredAttribution(): StoredAttribution | null {
  try {
    const raw = localStorage.getItem(ATTRIBUTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as StoredAttribution) : null;
  } catch {
    return null;
  }
}

function writeStoredAttribution(value: StoredAttribution): void {
  try {
    localStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage unavailable — this visit simply goes unattributed.
  }
}

/** Extracts ref/utm_* from a query string; null when none are present. */
export function parseAttribution(search: string, now: Date = new Date()): StoredAttribution | null {
  const params = new URLSearchParams(search);
  const result: StoredAttribution = { landingAt: now.toISOString() };
  let found = false;
  for (const [param, field] of PARAMS) {
    const raw = params.get(param);
    const value = raw === null ? null : normalizeAttributionValue(raw);
    if (value) {
      result[field] = value;
      found = true;
    }
  }
  return found ? result : null;
}

export function captureAttribution(apiBaseUrl: string, search: string = window.location.search): void {
  const landed = parseAttribution(search);
  if (!landed) return;

  // First touch wins: whoever brought this browser here first keeps the
  // credit, even if a later visit comes through someone else's link.
  if (!readStoredAttribution()) writeStoredAttribution(landed);

  // Counted per landing (the ref in *this* URL), at most once per browser
  // session — a reload or in-site navigation is not another visit.
  if (!landed.ref) return;
  let alreadyCounted = false;
  try {
    alreadyCounted = sessionStorage.getItem(REF_VISIT_SESSION_KEY) === "1";
    if (!alreadyCounted) sessionStorage.setItem(REF_VISIT_SESSION_KEY, "1");
  } catch {
    // Without sessionStorage we can't dedupe; counting once per page load
    // is an acceptable overcount for such browsers.
  }
  if (alreadyCounted) return;
  fetch(`${apiBaseUrl}/ref-visits`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: landed.ref }),
    keepalive: true,
  }).catch(() => {
    // Best effort — a lost visit count is not worth surfacing.
  });
}

/**
 * Sends the stored first-touch attribution to the signed-in user's account,
 * once per browser. Resolves when done (or skipped); never rejects.
 */
export async function sendAttributionIfNeeded(apiBaseUrl: string): Promise<void> {
  const stored = readStoredAttribution();
  if (!stored || stored.sentAt) return;
  try {
    const res = await fetch(`${apiBaseUrl}/auth/attribution`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: stored.ref,
        utmSource: stored.utmSource,
        utmMedium: stored.utmMedium,
        utmCampaign: stored.utmCampaign,
        utmContent: stored.utmContent,
      }),
    });
    // Any 2xx is final — including { recorded: false } (the account was
    // already attributed elsewhere). A failure is retried on a later load.
    if (res.ok) writeStoredAttribution({ ...stored, sentAt: new Date().toISOString() });
  } catch {
    // Network failure — try again on the next page load.
  }
}
