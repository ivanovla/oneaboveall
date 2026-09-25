import { tick } from "engine/engine/scheduler";

// Nothing in this codebase called scheduler.tick() outside of tests before
// this file existed — bidding windows would never actually close in
// production. This is the one place that drives it: a self-rescheduling
// interval that runs for the lifetime of the process.
const TICK_INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS ?? 3000);

// Fire-and-forget on purpose: by the time this runs, installChampion's
// transaction has already committed (see installChampion.ts's own comment
// on why onInstalled runs outside its try/catch). A failed or slow rebuild
// trigger must never be mistaken for a failed round resolution — worst case
// the public scene keeps showing the previous champion until the next
// round closes and this fires again.
//
// Read fresh on every call rather than cached at module load: set in
// production to the web rebuilder sidecar's internal-only /rebuild endpoint
// (see infra/k8s/web.yaml), left unset in dev/test where there is no static
// site to regenerate.
async function notifyWebRebuild(): Promise<void> {
  const webRebuildUrl = process.env.WEB_REBUILD_URL;
  if (!webRebuildUrl) return;
  try {
    const res = await fetch(webRebuildUrl, { method: "POST" });
    if (!res.ok) {
      console.error(`scheduler: web rebuild trigger responded with ${res.status}`);
    }
  } catch (err) {
    console.error("scheduler: failed to reach web rebuild trigger", err);
  }
}

export function startScheduler(): void {
  setInterval(() => {
    tick(new Date(), () => {
      void notifyWebRebuild();
    }).catch((err) => {
      // tick() already isolates per-round failures internally (see
      // scheduler.ts's own comment) — reaching here means something failed
      // before that loop even started (e.g. the initial rounds select).
      // Logging and letting the next interval retry is the same recovery
      // behavior tick() already applies to a single round's failure.
      console.error("scheduler: tick failed", err);
    });
  }, TICK_INTERVAL_MS);
}
