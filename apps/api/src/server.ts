import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";
import { registerSceneRoute } from "./routes/scene";
import { registerLeaderboardRoute } from "./routes/leaderboard";
import { registerCurrentRoundRoute } from "./routes/currentRound";
import { registerJoinRoundRoute } from "./routes/joinRound";
import { registerPlaceBidRoute } from "./routes/placeBid";
import { stripe, STRIPE_CURRENCY } from "./stripeClient";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  registerSceneRoute(app);
  registerLeaderboardRoute(app);
  registerCurrentRoundRoute(app);
  registerJoinRoundRoute(app, stripe, STRIPE_CURRENCY);
  registerPlaceBidRoute(app);
  return app;
}
