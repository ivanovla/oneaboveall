import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  return app;
}
