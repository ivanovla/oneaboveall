import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";
import { registerSceneRoute } from "./routes/scene";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  registerSceneRoute(app);
  return app;
}
