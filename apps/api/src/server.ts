import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import secureJson from "secure-json-parse";
import { registerSceneRoute } from "./routes/scene";
import { registerLeaderboardRoute } from "./routes/leaderboard";
import { registerCurrentRoundRoute } from "./routes/currentRound";
import { registerJoinRoundRoute } from "./routes/joinRound";
import { registerPlaceBidRoute } from "./routes/placeBid";
import { registerStripeWebhookRoute } from "./routes/stripeWebhook";
import { registerGoogleAuthRoutes } from "./routes/authGoogle";
import { stripe, STRIPE_CURRENCY, STRIPE_WEBHOOK_SECRET } from "./stripeClient";
import { StripePaymentProvider } from "./payments/StripePaymentProvider";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  const corsOrigin = process.env.CORS_ORIGIN;
  if (!corsOrigin) {
    throw new Error("CORS_ORIGIN is required.");
  }
  app.register(fastifyCors, { origin: corsOrigin, credentials: true });
  app.register(fastifyCookie);

  // Captures the raw request bytes onto request.rawBody in addition to the
  // normal parsed JSON body — Stripe's webhook signature check needs the
  // exact bytes Stripe signed, which JSON.stringify(JSON.parse(...)) is not
  // guaranteed to reproduce (key order and whitespace are both free to
  // differ). Fastify permits replacing its own built-in "application/json"
  // parser this way without a removeContentTypeParser call first; every other
  // route keeps receiving an ordinary parsed body from `done(null, json)`.
  //
  // Parsing goes through secure-json-parse with the same settings Fastify's
  // own default parser uses, rather than a bare JSON.parse — otherwise
  // replacing the parser would silently strip prototype-poisoning protection
  // ({"__proto__":{...}} / {"constructor":{"prototype":...}}) from every JSON
  // route on this service, including routes not written yet.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    try {
      const json = body.length
        ? secureJson.parse(body.toString("utf8"), null, { protoAction: "error", constructorAction: "error" })
        : {};
      done(null, json);
    } catch (err) {
      // Fastify's default parser stamps statusCode 400 on the SyntaxError it
      // throws; without doing the same, a malformed body falls through to the
      // generic 500 handler and a client error is reported as a server crash.
      (err as Error & { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  // STRIPE_WEBHOOK_SECRET's presence is already validated by stripeClient.ts
  // at import time — asserted here only to narrow its type from
  // `string | undefined` to `string` for registerStripeWebhookRoute below.
  if (!STRIPE_WEBHOOK_SECRET) {
    throw new Error("STRIPE_WEBHOOK_SECRET is required.");
  }
  const stripeProvider = new StripePaymentProvider(stripe, STRIPE_CURRENCY);

  registerSceneRoute(app);
  registerLeaderboardRoute(app);
  registerCurrentRoundRoute(app);
  registerJoinRoundRoute(app, stripe, STRIPE_CURRENCY);
  registerPlaceBidRoute(app);
  registerStripeWebhookRoute(app, stripe, STRIPE_WEBHOOK_SECRET, stripeProvider);
  registerGoogleAuthRoutes(app);

  return app;
}
