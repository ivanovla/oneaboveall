// Attribution values (a streamer's `ref` code, utm_* campaign tags) arrive
// from the query string of whatever link someone clicked — fully
// attacker-controlled — and then travel into the database, Stripe
// PaymentIntent metadata and the operator's stats. Rather than escaping them
// differently at each of those sinks, they're restricted up front to a
// boring, URL-safe alphabet: anything outside it is dropped, not repaired.
// Real campaign tags ("twitch", "streamer_bob", "launch-2026.10") all fit.
const ATTRIBUTION_VALUE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function sanitizeAttributionValue(value: unknown): string | null {
  return typeof value === "string" && ATTRIBUTION_VALUE_RE.test(value) ? value : null;
}

export type Attribution = {
  ref: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
};

export const ATTRIBUTION_FIELDS = ["ref", "utmSource", "utmMedium", "utmCampaign", "utmContent"] as const;

/** Sanitizes every field independently: one bad value never discards the others. */
export function sanitizeAttribution(input: unknown): Attribution {
  const source = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  return {
    ref: sanitizeAttributionValue(source.ref),
    utmSource: sanitizeAttributionValue(source.utmSource),
    utmMedium: sanitizeAttributionValue(source.utmMedium),
    utmCampaign: sanitizeAttributionValue(source.utmCampaign),
    utmContent: sanitizeAttributionValue(source.utmContent),
  };
}
