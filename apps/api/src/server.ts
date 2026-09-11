import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";
import { registerSceneRoute } from "./routes/scene";
import { registerLeaderboardRoute } from "./routes/leaderboard";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  registerSceneRoute(app);
  registerLeaderboardRoute(app);
  return app;
}
