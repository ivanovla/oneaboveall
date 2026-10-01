// In-process throttle for POST /ref-visits (see attribution.ts). The route
// is public and unauthenticated, so without this anyone with curl could
// inflate a streamer's visit count — or a competitor's — at will. It only
// decides whether a visit is *counted*: the route answers 204 either way,
// so a client hitting the limit learns nothing it could tune against.
//
// Two rules, both keyed on the client IP:
//   - one counted visit per IP per ref per 30 minutes — a refresh, a second
//     tab or a reopened browser on the same link is the same visit;
//   - at most 30 ref-visit requests per IP per hour, whatever the ref (and
//     whether or not it was even valid) — so cycling through refs from one
//     address can't fill the table either.
//
// Deliberately simple and approximate: state lives in this process's
// memory, so it resets on restart and isn't shared between API replicas
// (the deployment runs one), and a crowd behind one NAT (a campus, a mobile
// carrier) shares a budget. Visit counts are a rough traffic signal for
// creators, not money — see infra/README.md.
//
// Memory is bounded: each map holds at most `maxEntries` keys. When one is
// full, expired entries are swept first; if it's still full, the oldest
// entries go (Maps iterate in insertion order, and a key is re-inserted
// whenever its window restarts, so the front of the map is always the
// stalest). Evicting a live entry only ever errs towards counting a visit
// again — the safe direction for a public counter.

export type RefVisitLimiterOptions = {
  perRefWindowMs?: number;
  perIpWindowMs?: number;
  perIpMax?: number;
  maxEntries?: number;
  now?: () => number;
};

export class RefVisitLimiter {
  private readonly perRefWindowMs: number;
  private readonly perIpWindowMs: number;
  private readonly perIpMax: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  // ip -> fixed window of requests: when it started, how many so far.
  private readonly ips = new Map<string, { windowStart: number; count: number }>();
  // "ip\nref" -> when that pair's visit was last counted.
  private readonly visits = new Map<string, number>();

  constructor(options: RefVisitLimiterOptions = {}) {
    this.perRefWindowMs = options.perRefWindowMs ?? 30 * 60_000;
    this.perIpWindowMs = options.perIpWindowMs ?? 60 * 60_000;
    this.perIpMax = options.perIpMax ?? 30;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  // Records one ref-visit request from `ip` and says whether it should be
  // counted. `ref` is the already-sanitized ref, or null for one that was
  // missing or invalid — that request still spends the IP's budget, but is
  // never counted.
  allow(ip: string, ref: string | null): boolean {
    const now = this.now();

    let window = this.ips.get(ip);
    if (!window || now - window.windowStart >= this.perIpWindowMs) {
      // New window: delete before set so the key moves to the back of the
      // map, keeping the front the stalest for eviction.
      this.ips.delete(ip);
      this.makeRoom(this.ips, (w) => now - w.windowStart >= this.perIpWindowMs);
      window = { windowStart: now, count: 0 };
      this.ips.set(ip, window);
    }
    window.count++;
    if (window.count > this.perIpMax) return false;
    if (!ref) return false;

    const key = `${ip}\n${ref}`;
    const lastCounted = this.visits.get(key);
    if (lastCounted !== undefined && now - lastCounted < this.perRefWindowMs) return false;

    this.visits.delete(key);
    this.makeRoom(this.visits, (countedAt) => now - countedAt >= this.perRefWindowMs);
    this.visits.set(key, now);
    return true;
  }

  // For tests: how many keys each map currently holds.
  size(): { ips: number; visits: number } {
    return { ips: this.ips.size, visits: this.visits.size };
  }

  // Makes space for one more key: sweeps expired entries once the map is
  // full, then drops the oldest until it's down to 90% — freeing a batch at
  // a time, so a flood of distinct IPs pays for one full sweep per ~10% of
  // capacity rather than one per request.
  private makeRoom<V>(map: Map<string, V>, isExpired: (value: V) => boolean): void {
    if (map.size < this.maxEntries) return;
    for (const [key, value] of map) {
      if (isExpired(value)) map.delete(key);
    }
    const target = Math.floor(this.maxEntries * 0.9);
    for (const key of map.keys()) {
      if (map.size <= target) break;
      map.delete(key);
    }
  }
}
