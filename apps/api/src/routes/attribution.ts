import type { FastifyInstance } from "fastify";
import { incrementRefVisits, setUserAttributionOnce } from "engine/db/attribution";
import { sanitizeAttribution, sanitizeAttributionValue } from "engine/domain/attribution";
import { requireSession } from "../auth/requireSession";
import { RefVisitLimiter } from "./refVisitLimiter";

// Streamer attribution (launch-readiness spec §3). The browser keeps the
// first-touch ref/utm tags in localStorage (apps/web/src/lib/attribution.ts)
// and talks to these two routes:
//
//  - POST /ref-visits once per browser session that landed with ?ref=…,
//    counting traffic per streamer link. Public and unauthenticated, so a
//    garbage ref is a silent 204 no-op rather than an error a scraper could
//    learn from — and it never creates a row: only sanitized values count.
//  - PATCH /auth/attribution once after sign-in, stamping the user's
//    first-touch tags so sign-ups, bids and captured revenue can be credited
//    to the streamer (see engine/queries/admin.ts).
//
// /ref-visits is throttled per client IP (refVisitLimiter.ts): one counted
// visit per IP per ref per 30 minutes, ~30 requests per IP per hour. Over
// the limit it's the same silent 204, just not counted. request.ip is the
// real client address because server.ts trusts the one proxy hop (Traefik)
// in front of this service.
export function registerAttributionRoutes(app: FastifyInstance, limiter: RefVisitLimiter = new RefVisitLimiter()): void {
  app.post<{ Body: { ref?: unknown } }>("/ref-visits", async (request, reply) => {
    const ref = sanitizeAttributionValue(request.body?.ref);
    if (limiter.allow(request.ip, ref) && ref) await incrementRefVisits(ref);
    reply.code(204);
    return reply.send();
  });

  app.patch<{ Body: Record<string, unknown> }>("/auth/attribution", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;

    // Write-once and per-field sanitized: an invalid tag is dropped, the
    // valid ones still count, and a second call (another tab, a later
    // visit through a different streamer's link) changes nothing.
    const recorded = await setUserAttributionOnce(user.id, sanitizeAttribution(request.body), new Date());
    return { recorded };
  });
}
