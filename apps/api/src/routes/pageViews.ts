import type { FastifyInstance } from "fastify";
import { incrementPageViews } from "engine/db/repository";

const FLUSH_INTERVAL_MS = 5_000;

// Called once per real page load (see ViewCounter.tsx) — at real scale this
// can be the single most frequently hit route in the service, and unlike
// currentRound.ts's GET (a pure read a TTL cache can just skip re-fetching),
// every call here has to actually count. So instead of one DB write per
// call, this batches counts in memory and flushes their sum on an interval:
// N page loads within FLUSH_INTERVAL_MS collapse into a single UPDATE.
// Deliberately per-process, not shared/distributed — same caveat as
// currentRound.ts's cache: safe to run as multiple apps/api instances
// later, each just keeps its own pending count and flushes independently.
let pending = 0;
let total: number | null = null; // null until the very first flush ever completes
let lastFlushAt = 0;
let flushing: Promise<void> | null = null;

async function flush(): Promise<void> {
  if (flushing) return flushing;
  const amount = pending;
  if (amount === 0) return;
  // `pending` is deliberately NOT reduced here, before the write starts —
  // only inside the success callback below, by exactly the `amount` this
  // flush captured. Any view counted by a request that arrives while this
  // write is still in flight stays reflected in `pending` (and so in every
  // response's `total + pending`) the entire time, instead of a window
  // where it's been "claimed" by this flush but not yet in `total`.
  flushing = incrementPageViews(amount)
    .then((newTotal) => {
      pending -= amount;
      total = newTotal;
    })
    .catch((err) => {
      // Nothing to roll back — `pending` was never reduced — so the next
      // due flush just retries this same amount plus whatever accumulated
      // since.
      console.error("page-views: failed to flush pending views", err);
    })
    .finally(() => {
      lastFlushAt = Date.now();
      flushing = null;
    });
  return flushing;
}

// Test-only: same reasoning as currentRound.ts's __resetCacheForTests —
// this module-level state would otherwise leak between tests that each
// build their own server instance in the same process.
export function __resetCacheForTests(): void {
  pending = 0;
  total = null;
  lastFlushAt = 0;
  flushing = null;
}

export function registerPageViewsRoute(app: FastifyInstance): void {
  app.post("/page-views", async () => {
    pending += 1;
    const dueForFlush = total === null || Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS;
    if (dueForFlush) {
      if (total === null) {
        // Cold start (first call this process has ever seen) — worth
        // waiting on once, so this response carries a real number instead
        // of a bare "1".
        await flush();
      } else {
        // A routine scheduled flush must never make the hot path wait on a
        // database write — fire it and answer from the in-memory estimate.
        void flush();
      }
    }
    return { count: (total ?? 0) + pending };
  });
}
