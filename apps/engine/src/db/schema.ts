import { pgTable, text, integer, timestamp, uuid, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";

// A round only ever has these two phases now: settlement is synchronous with
// the bidding window closing (the winner already paid in full when they bid),
// so there's no intermediate "resolving"/"payment" state to be in.
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

// Every bid is a real, full-amount Stripe charge collected up front — there
// is no separate deposit concept. paymentRef is that charge's PaymentIntent
// id: unique per row so a redelivered `payment_intent.succeeded` webhook is a
// safe no-op instead of recording the same bid twice. refundedAt is null
// while the money is still ours (this bid is either the round's current
// leader, or already won a closed round) and gets set the instant another
// bidder outbids it — at that point the full amount is handed straight back,
// there is nothing left to reconcile at round close.
export const bids = pgTable("bids", {
  id: uuid("id").defaultRandom().primaryKey(),
  roundId: uuid("round_id").notNull().references(() => rounds.id),
  bidderId: text("bidder_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  paymentRef: text("payment_ref").notNull(),
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  providerIdentityIdx: uniqueIndex("users_provider_provider_id_idx").on(table.provider, table.providerId),
}));

// An opaque, server-validated session token — never a client-decodable JWT.
// The browser only ever sees `token`, delivered as an httpOnly cookie.
export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
