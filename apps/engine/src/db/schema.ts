import { pgTable, text, integer, timestamp, uuid, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";

// "applied" = the winner's deposit was credited toward the final price rather
// than returned; distinct from "refunded" so accounting rollups don't count it
// as money given back.
export const depositStatusEnum = pgEnum("deposit_status", ["held", "refunded", "forfeited", "applied"]);
export const roundPhaseEnum = pgEnum("round_phase", ["bidding", "resolving", "payment", "closed"]);
export const offerStatusEnum = pgEnum("offer_status", ["pending", "processing", "paid", "expired"]);

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

// One row per (round, bidder): the fixed, once-per-round deposit that unlocks
// bidding for that bidder in that round. depositCents is fixed at
// calculateDeposit(reign.priceCents) when the row is created — never
// recomputed from any individual bid amount. paymentMethodRef is the saved
// Stripe PaymentMethod id (captured from the deposit PaymentIntent via
// setup_future_usage: "off_session"), used later for the automatic
// off-session remainder charge if this bidder wins. customerRef is the Stripe
// Customer that PaymentMethod is attached to — Stripe only allows a saved
// PaymentMethod to be reused in a *later, separate* PaymentIntent (which is
// exactly what the remainder charge is) when both the original and the reuse
// name the same Customer. Without it the remainder charge fails with
// payment_method_unattached, which the engine would misread as a decline.
export const roundParticipants = pgTable("round_participants", {
  id: uuid("id").defaultRandom().primaryKey(),
  roundId: uuid("round_id").notNull().references(() => rounds.id),
  bidderId: text("bidder_id").notNull(),
  depositCents: integer("deposit_cents").notNull(),
  depositRef: text("deposit_ref").notNull(),
  paymentMethodRef: text("payment_method_ref").notNull(),
  customerRef: text("customer_ref").notNull(),
  depositStatus: depositStatusEnum("deposit_status").notNull().default("held"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // Enforces "one deposit per bidder per round" at the database level — this
  // is what makes joinRound's insert-or-detect-duplicate idempotent against a
  // Stripe webhook redelivering the same payment_intent.succeeded event.
  roundBidderIdx: uniqueIndex("round_participants_round_id_bidder_id_idx").on(table.roundId, table.bidderId),
}));

export const bids = pgTable("bids", {
  id: uuid("id").defaultRandom().primaryKey(),
  roundId: uuid("round_id").notNull().references(() => rounds.id),
  bidderId: text("bidder_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // Supports the leader query (WHERE round_id = ? ORDER BY amount_cents DESC,
  // placed_at ASC LIMIT 1), which runs inside placeBidAtomic's SERIALIZABLE
  // transaction on every bid — the hottest lock in the system. Column order and
  // direction match that ORDER BY exactly so it can be answered by an index
  // scan instead of a sequential scan plus sort.
  roundLeaderIdx: index("bids_round_id_amount_cents_placed_at_idx").on(
    table.roundId,
    table.amountCents.desc(),
    table.placedAt.asc(),
  ),
}));

export const paymentOffers = pgTable("payment_offers", {
  id: uuid("id").defaultRandom().primaryKey(),
  roundId: uuid("round_id").notNull().references(() => rounds.id),
  bidId: uuid("bid_id").notNull().references(() => bids.id),
  offeredAt: timestamp("offered_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  status: offerStatusEnum("status").notNull().default("pending"),
});

export const bans = pgTable("bans", {
  id: uuid("id").defaultRandom().primaryKey(),
  bidderId: text("bidder_id").notNull(),
  bannedUntil: timestamp("banned_until", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  // resolved server-side only, never joined with user input.
  photoPath: text("photo_path"),
  instagramUrl: text("instagram_url"),
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
