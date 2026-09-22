import type { FastifyInstance } from "fastify";
import { getCurrentRoundInfo } from "engine/queries/publicScene";

export function registerCurrentRoundRoute(app: FastifyInstance): void {
  app.get("/current-round", async () => {
    return getCurrentRoundInfo(new Date());
  });
}
