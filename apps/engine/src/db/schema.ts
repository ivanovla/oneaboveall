import { pgTable, text, integer, timestamp, uuid, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";

// A round only ever has these two phases: settlement (capturing the
// winner's hold) runs while the round is still "bidding" — at the daily
// close, before the champion-processing gap — and the round flips to
// "closed" only when it is finally resolved, so there's no separate
// "resolving"/"payment" phase to be in. Whether settlement has happened is
// read from the bids themselves (bids.captured_at).
export const roundPhaseEnum = pgEnum("round_phase", ["bidding", "closed"]);

export const reigns = pgTable("reigns", {
  id: uuid("id").defaultRandom().primaryKey(),
  occupantId: text("occupant_id").notNull(),
  priceCents: integer("price_cents").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const rounds = pgTable("rounds", {
  id: uuid("id").defaultRandom().primaryKey(),
  reignId: uuid("reign_id").notNull().references(() => reigns.id),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  phase: roundPhaseEnum("phase").notNull().default("bidding"),
});

// Every bid is a Stripe *authorization hold* for its full amount
// (PaymentIntent with capture_method: "manual"), not a charge — only the
// round's winner is ever actually collected, at the daily close (see
// engine/settlement.ts). paymentRef is that hold's PaymentIntent id: unique
// per row so a redelivered webhook (or the `succeeded` event our own capture
// fires after the `amount_capturable_updated` one that recorded the bid) is a
// safe no-op instead of recording the same bid twice.
//
// refundedAt keeps its historical name (column refunded_at) but now means
// "released": the hold was cancelled, or — for a bid placed before holds
// existed, or one already captured — the charge was refunded. Either way the
// bidder owes nothing for it any more. Null while the hold is still alive:
// at most two per round at a time, the leader and the runner-up kept as the
// fallback in case capturing the leader fails (see recordBid.ts).
//
// capturedAt is set once the hold has actually been collected — the bid
// won its round. captureFailedAt records that settlement tried to collect
// this bid and the attempt definitively failed (declined, hold expired or
// cancelled); such a bid is also released (refundedAt set) so settlement
// moves on to the runner-up.
export const bids = pgTable("bids", {
  id: uuid("id").defaultRandom().primaryKey(),
  roundId: uuid("round_id").notNull().references(() => rounds.id),
  bidderId: text("bidder_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  paymentRef: text("payment_ref").notNull(),
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
  capturedAt: timestamp("captured_at", { withTimezone: true }),
  captureFailedAt: timestamp("capture_failed_at", { withTimezone: true }),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // Supports the leader query (WHERE round_id = ? ORDER BY amount_cents DESC,
  // placed_at ASC LIMIT 1), which runs inside recordBidAtomic's SERIALIZABLE
  // transaction on every bid — the hottest lock in the system. Column order and
  // direction match that ORDER BY exactly so it can be answered by an index
  // scan instead of a sequential scan plus sort.
  roundLeaderIdx: index("bids_round_id_amount_cents_placed_at_idx").on(
    table.roundId,
    table.amountCents.desc(),
    table.placedAt.asc(),
  ),
  paymentRefIdx: uniqueIndex("bids_payment_ref_idx").on(table.paymentRef),
}));

// A signed-in bidder. provider+providerId is the OAuth identity; id is what
// the rest of the engine already calls bidderId (its columns are plain
// `text`, so no other table changes — a user's id is used directly).
// Two OAuth accounts for the same real person (one Google, one Apple)
// deliberately produce two separate rows here — account linking is out of
// scope.
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: text("provider").notNull(), // "google" | "apple"
  providerId: text("provider_id").notNull(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  // Both null until the user completes the post-bid photo/social step (see
  // POST /auth/photo, PATCH /auth/social). photoPath is a filename under
  // apps/api's local uploads directory, never a client-supplied path —
  // resolved server-side only, never joined with user input. socialUrl is a
  // link to any social network profile (Instagram, X, TikTok, a personal
  // site, …) — not restricted to one platform — shown alongside the photo
  // once this user is the reigning champion.
  photoPath: text("photo_path"),
  socialUrl: text("social_url"),
  // Freeform, optional: how this bidder would like their character rendered
  // in the scene (clothing, style, mood, …) — captured alongside the photo
  // upload for whoever composes the scene art, never parsed or acted on by
  // this codebase itself.
  characterRequest: text("character_request"),
  // Set the instant a photo upload actually succeeds (POST /auth/photo),
  // never client-supplied — this is the record that the person confirmed,
  // at that moment, that they own the photo's rights or have permission to
  // use it and grant this site a license to display it (and any artwork
  // rendered from it) publicly. Null means no upload has ever succeeded, not
  // that consent was withheld — there's nothing to consent to yet.
  photoConsentAt: timestamp("photo_consent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  providerIdentityIdx: uniqueIndex("users_provider_provider_id_idx").on(table.provider, table.providerId),
}));

// A single-row counter (id is always 1) tracking how many times the
// homepage has been loaded — incremented once per real page view via
// POST /page-views (see apps/api/src/routes/pageViews.ts), called from the
// browser itself, never at build time. Deliberately not per-visitor/unique:
// the product asks "how many times has this page been viewed", not "how
// many distinct people have viewed it".
export const pageViews = pgTable("page_views", {
  id: integer("id").primaryKey(),
  count: integer("count").notNull().default(0),
});

// An opaque, server-validated session token — never a client-decodable JWT.
// The browser only ever sees `token`, delivered as an httpOnly cookie.
export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
