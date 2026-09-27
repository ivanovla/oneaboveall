import type { FastifyInstance } from "fastify";
import { incrementPageViews } from "engine/db/repository";

// Called once per real page load, from the browser itself (ViewCounter.tsx)
// — never at build time, since apps/web is a static build and this needs to
// count actual visits, not builds. POST rather than GET: this has a side
// effect (increments a counter) every time it's called, so it isn't safe to
// prefetch or retry silently the way a GET is assumed to be.
export function registerPageViewsRoute(app: FastifyInstance): void {
  app.post("/page-views", async () => {
    const count = await incrementPageViews();
    return { count };
  });
}
