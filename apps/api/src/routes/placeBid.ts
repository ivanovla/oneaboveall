import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { and, eq, isNull } from "drizzle-orm";
import { prepareBid } from "engine/engine/prepareBid";
import { db } from "engine/db/client";
import { users } from "engine/db/schema";
import { getUserAttribution } from "engine/db/attribution";
import type { Attribution } from "engine/domain/attribution";
import { requireSession } from "../auth/requireSession";

// Stripe metadata keys for the bidder's first-touch attribution, so a
// payment can be traced to the streamer who sent the bidder from the Stripe
// dashboard alone. Values were sanitized to ^[A-Za-z0-9_.-]{1,64}$ when
// stored (engine/domain/attribution.ts) — comfortably within Stripe's
// 500-character value limit. Empty fields are omitted rather than sent as
// "" (Stripe treats an empty value as "unset" anyway).
const ATTRIBUTION_METADATA_KEYS: Record<keyof Attribution, string> = {
  ref: "ref",
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
  utmContent: "utm_content",
};

function attributionMetadata(attribution: Attribution | null): Record<string, string> {
  const metadata: Record<string, string> = {};
  if (!attribution) return metadata;
  for (const [field, key] of Object.entries(ATTRIBUTION_METADATA_KEYS) as [keyof Attribution, string][]) {
    const value = attribution[field];
    if (value) metadata[key] = value.slice(0, 500);
  }
  return metadata;
}

// No `bidderId` in the Body type: the bidder is derived from the session
// cookie below. A bid puts a full-amount, on-session hold on a card, so
// accepting a caller-supplied bidderId — as this route once did — would let
// anyone bid (and hold or charge a card) in anyone else's name.
export function registerPlaceBidRoute(app: FastifyInstance, stripe: Stripe, currency: string): void {
  app.post<{ Body: { amountCents?: number; acceptedTerms?: unknown } }>("/bids", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;

    const { amountCents, acceptedTerms } = request.body ?? {};
    if (typeof amountCents !== "number") {
      reply.code(400);
      return { error: "amountCents is required" };
    }
    // The bid step's required checkbox: 18+, agreement to the Terms, and
    // the EU withdrawal-right waiver for a service performed immediately
    // (spec §8). Enforced here, not just by a disabled button, because a
    // hold on someone's card must never be placed without it — and only
    // the literal `true` counts, not a truthy string.
    if (acceptedTerms !== true) {
      reply.code(400);
      return { error: "You must confirm you're 18 or older and accept the Terms to bid." };
    }
    // First acceptance only: the `IS NULL` guard keeps the original
    // timestamp, i.e. when this person first agreed, across later bids.
    await db
      .update(users)
      .set({ termsAcceptedAt: new Date() })
      .where(and(eq(users.id, user.id), isNull(users.termsAcceptedAt)));

    const now = new Date();
    const result = await prepareBid({ bidderId: user.id, amountCents, now });
    if (!result.ok) {
      reply.code(422);
      return { error: result.reason };
    }

    // The bid itself is only recorded once the hold is in place and the
    // Stripe webhook lands (see stripeWebhook.ts / engine/engine/recordBid)
    // — exactly like the round is re-checked there too, since anything here
    // is just a fast pre-authorization sanity check, not the authoritative
    // one.
    //
    // capture_method "manual": confirming this only *authorizes* the amount.
    // It is collected at the daily close only if this bid wins
    // (engine/engine/settlement.ts); otherwise the hold is cancelled, so an
    // outbid bidder is never charged and refunded.
    const attribution = await getUserAttribution(user.id);
    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency,
      capture_method: "manual",
      description: "oneaboveall.org seat bid",
      metadata: {
        kind: "bid",
        roundId: result.roundId,
        bidderId: user.id,
        amountCents: String(amountCents),
        ...attributionMetadata(attribution),
      },
    });

    return { clientSecret: intent.client_secret };
  });
}
