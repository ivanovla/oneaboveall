import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyFormbody from "@fastify/formbody";
import fastifyMultipart from "@fastify/multipart";
import secureJson from "secure-json-parse";
import { registerSceneRoute } from "./routes/scene";
import { registerLeaderboardRoute } from "./routes/leaderboard";
import { registerCurrentRoundRoute } from "./routes/currentRound";
import { registerPlaceBidRoute } from "./routes/placeBid";
import { registerRoundParticipationRoute } from "./routes/roundParticipation";
import { registerStripeWebhookRoute } from "./routes/stripeWebhook";
import { registerGoogleAuthRoutes } from "./routes/authGoogle";
import { registerAppleAuthRoutes } from "./routes/authApple";
import { registerAuthMeRoutes } from "./routes/authMe";
import { registerPhotoRoutes } from "./routes/photo";
import { registerHistoryRoute } from "./routes/history";
import { registerPageViewsRoute } from "./routes/pageViews";
import { registerAttributionRoutes } from "./routes/attribution";
import { registerAdminRoutes } from "./routes/admin";
import { stripe, STRIPE_CURRENCY, STRIPE_WEBHOOK_SECRET } from "./stripeClient";
import { StripePaymentProvider } from "./payments/StripePaymentProvider";
import { ResendNotifier } from "./notifications/ResendNotifier";
import type { PaymentProvider } from "engine/payments/PaymentProvider";
import type { Notifier } from "engine/notifications/Notifier";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

// index.ts passes the same provider/notifier instances it hands to the
// scheduler (so e.g. the "RESEND_API_KEY unset" warning is logged once per
// process, not once per consumer); tests that don't care get the defaults.
export function buildServer(
  deps: { provider?: PaymentProvider; notifier?: Notifier } = {},
): FastifyInstance {
  const app = Fastify({
    logger: {
      // Fastify's default request serializer logs the full request URL,
      // including its query string. Several routes put credential-shaped
      // values in the query string — most notably the Google OAuth
      // authorization code on GET /auth/google/callback?code=...&state=...,
      // a real (if short-lived, single-use) secret — so logging it verbatim
      // at info level on every request would put it in plaintext log
      // storage. Stripping the query string before logging is a reasonable
      // default for every route, not just this one.
      // Mirrors Fastify's own default req serializer (fastify/lib/logger.js)
      // field-for-field, only replacing `url` with its query-string-stripped
      // form.
      serializers: {
        req(request) {
          const acceptVersion = request.headers?.["accept-version"];
          return {
            method: request.method,
            url: request.url.split("?")[0],
            version: Array.isArray(acceptVersion) ? acceptVersion[0] : acceptVersion,
            hostname: request.hostname,
            remoteAddress: request.ip,
            remotePort: request.socket?.remotePort,
          };
        },
      },
    },
  });

  const corsOrigin = process.env.CORS_ORIGIN;
  if (!corsOrigin) {
    throw new Error("CORS_ORIGIN is required.");
  }
  // Every route on this service is served with `credentials: true` (the
  // session and OAuth-state cookies depend on it), and the CORS spec forbids
  // combining a wildcard `Access-Control-Allow-Origin: *` with
  // `Access-Control-Allow-Credentials: true`. The browser — not the server —
  // is what rejects that pair, so a wildcard here boots perfectly happily and
  // then fails every single cross-origin request from the real frontend, with
  // the only symptom being a CORS error in the user's devtools. Failing at
  // boot turns that into an unmissable deploy-time error instead.
  //
  // The comma-separated form is checked too: @fastify/cors accepts a list,
  // and a stray "*" anywhere in it is the same mistake.
  const allowedOrigins = corsOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
  if (allowedOrigins.some((origin) => origin === "*")) {
    throw new Error(
      'CORS_ORIGIN must not be "*": this server sends credentialed CORS responses, which browsers reject against a wildcard origin. Set it to the frontend\'s exact origin (e.g. http://127.0.0.1:4321).',
    );
  }
  if (allowedOrigins.length === 0) {
    throw new Error("CORS_ORIGIN is required.");
  }
  // Passed as an ARRAY, not the raw string. @fastify/cors treats a string
  // `origin` as a literal value echoed verbatim into
  // Access-Control-Allow-Credentials' companion header — it does not split on
  // commas — so a comma-separated CORS_ORIGIN would have emitted
  // `Access-Control-Allow-Origin: http://a,https://b`, a header no browser
  // accepts. With an array, @fastify/cors matches the request's own Origin
  // against the list and echoes back just that one (plus `Vary: Origin`),
  // which is the only form that works alongside `credentials: true`. A single
  // origin is simply a one-element array.
  app.register(fastifyCors, { origin: allowedOrigins, credentials: true });
  app.register(fastifyCookie);
  // Apple's Sign in with Apple callback uses response_mode: "form_post" —
  // the browser POSTs the callback (code, state, and the one-time "user"
  // JSON blob) as application/x-www-form-urlencoded, not JSON. Fastify has
  // no built-in parser for that content type, so without this the request
  // 415s before POST /auth/apple/callback's handler ever runs. This is the
  // standard, well-tested plugin for it (same reasoning as using
  // @fastify/cookie/@fastify/cors above rather than hand-rolling that
  // plumbing).
  app.register(fastifyFormbody);
  // POST /auth/photo's multipart/form-data upload — the photo file itself,
  // capped well under Node's default heap pressure point for a single
  // request.
  app.register(fastifyMultipart, { limits: { fileSize: 12 * 1024 * 1024 } });

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
  const stripeProvider = deps.provider ?? new StripePaymentProvider(stripe);
  const notifier = deps.notifier ?? new ResendNotifier();

  registerSceneRoute(app);
  registerLeaderboardRoute(app);
  registerCurrentRoundRoute(app);
  registerPlaceBidRoute(app, stripe, STRIPE_CURRENCY);
  registerRoundParticipationRoute(app);
  registerStripeWebhookRoute(app, stripe, STRIPE_WEBHOOK_SECRET, stripeProvider, notifier);
  registerGoogleAuthRoutes(app);
  registerAppleAuthRoutes(app);
  registerAuthMeRoutes(app);
  registerPhotoRoutes(app);
  registerHistoryRoute(app);
  registerPageViewsRoute(app);
  registerAttributionRoutes(app);
  registerAdminRoutes(app);

  // Liveness/readiness target for the k8s Deployment (see
  // infra/k8s/api.yaml). Deliberately does not touch the database — this
  // answers "is the process alive and accepting connections", the same
  // question a TCP probe would ask; DB reachability already surfaces through
  // every real route's own error handling instead of gating pod readiness.
  app.get("/healthz", async () => ({ ok: true }));

  return app;
}
