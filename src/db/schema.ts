import { pgTable, text, integer, timestamp, uuid, pgEnum } from "drizzle-orm/pg-core";

export const depositStatusEnum = pgEnum("deposit_status", ["held", "refunded", "forfeited"]);
export const roundPhaseEnum = pgEnum("round_phase", ["bidding", "payment", "closed"]);
export const offerStatusEnum = pgEnum("offer_status", ["pending", "paid", "expired"]);

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

export const bids = pgTable("bids", {
  id: uuid("id").defaultRandom().primaryKey(),
  roundId: uuid("round_id").notNull().references(() => rounds.id),
  bidderId: text("bidder_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  depositCents: integer("deposit_cents").notNull(),
  depositRef: text("deposit_ref").notNull(),
  depositStatus: depositStatusEnum("deposit_status").notNull().default("held"),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
});

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
