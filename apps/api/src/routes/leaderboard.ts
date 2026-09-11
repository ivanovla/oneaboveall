import type { FastifyInstance } from "fastify";
import { getLeaderboard } from "engine/queries/publicScene";

export function registerLeaderboardRoute(app: FastifyInstance): void {
  app.get("/leaderboard", async () => {
    return getLeaderboard();
  });
}
