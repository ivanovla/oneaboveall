import type { FastifyInstance } from "fastify";
import { getCurrentRoundInfo } from "engine/queries/publicScene";

const CACHE_TTL_MS = 1_500;

// Many browser tabs poll this route every 5-10s (see the frontend design
// spec's Performance & Scale section). A short in-process cache collapses
// concurrent pollers within the TTL into a single DB round-trip instead of
// one getCurrentReign/getLatestRound/getQueueLeader sequence per request.
// Deliberately per-process, not shared/distributed — safe to run as
// multiple apps/api instances later without any coordination between them.
let cached: { value: Awaited<ReturnType<typeof getCurrentRoundInfo>>; expiresAt: number } | null = null;
let pending: Promise<Awaited<ReturnType<typeof getCurrentRoundInfo>>> | null = null;

async function getCachedCurrentRoundInfo() {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  if (!pending) {
    pending = getCurrentRoundInfo(new Date()).then(
      (value) => {
        cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
        pending = null;
        return value;
      },
      (err) => {
        // Clear pending on rejection (without populating cached) so the next
        // call retries against the DB instead of permanently returning this
        // same rejected promise after one transient failure.
        pending = null;
        throw err;
      },
    );
  }
  return pending;
}

// Test-only: clears the module-level cache so each test starts from a clean
// slate instead of silently inheriting whatever an earlier test in the same
// file run happened to cache. Exported (not module-private) specifically so
// apps/api/tests/currentRound.test.ts's beforeEach (Step 1) can call it —
// this cache is otherwise invisible/unreachable from outside the module.
export function __resetCacheForTests(): void {
  cached = null;
  pending = null;
}

export function registerCurrentRoundRoute(app: FastifyInstance): void {
  app.get("/current-round", async (_request, reply) => {
    // Every visitor on the homepage polls this route (see AuctionFlow.tsx's
    // live price/countdown), so at real scale this is the single
    // highest-traffic route in the whole service. The in-process cache above
    // already collapses concurrent pollers into one DB round-trip per
    // process; this header does the same one step earlier, letting any
    // reverse proxy or CDN in front of this service (nginx, Cloudflare, …)
    // absorb the same burst before it ever reaches this process at all.
    // `public` (not `private`) is deliberate: the response never varies by
    // caller — no cookie/session is read on this route.
    reply.header("cache-control", `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);
    return getCachedCurrentRoundInfo();
  });
}
