import type { FastifyInstance } from "fastify";
import { getScene } from "engine/queries/publicScene";

export function registerSceneRoute(app: FastifyInstance): void {
  app.get("/scene", async () => {
    return getScene(new Date());
  });
}
