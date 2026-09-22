import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is required.");
}
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  throw new Error("STRIPE_WEBHOOK_SECRET is required.");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Read once, here, rather than inline in server.ts — every Stripe-related env
// var and its validation lives in this one module so that any test which
// doesn't care about Stripe can mock this whole module away in one line
// (see scene.test.ts, leaderboard.test.ts, currentRound.test.ts) instead of
// needing real STRIPE_* values set just to construct the Fastify app.
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Fixed settlement currency for every Stripe call in this service — change
// here if a different currency is ever needed. Matches the dollar-denominated
// amounts already used throughout apps/engine/src/domain/config.ts.
export const STRIPE_CURRENCY = "usd";
