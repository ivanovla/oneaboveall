# Stripe Payment Integration — Engine & API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `apps/engine`'s deposit domain model to match the approved spec (a fixed,
once-per-round deposit instead of a per-bid charge), replace the placeholder `PaymentProvider`
with a real Stripe-backed implementation, and expose the new live, browser-reachable API routes
(`apps/api`) needed to join a round, place a bid, and receive Stripe webhooks.

**Architecture:** `apps/engine` gains a `roundParticipants` table (one row per bidder per round,
holding the deposit) and loses per-bid deposit tracking on `bids`. Deposit collection moves
entirely to `apps/api` + Stripe.js (on-session, user-driven); the engine's shrunk
`PaymentProvider` interface only covers what the engine itself initiates: the automatic
off-session remainder charge on a winner, and refunds. `apps/api` gains three new live routes
(`/current-round`, `/rounds/:id/join`, `/bids`) plus a Stripe webhook receiver.

**Tech Stack:** TypeScript, Drizzle ORM + PostgreSQL (`apps/engine`), Fastify (`apps/api`),
`stripe` npm SDK, Vitest.

**Scope note:** This plan deliberately excludes the frontend (Stripe Elements UI in
`apps/web`'s `AuctionFlow.tsx`) and the Kubernetes deployment manifests — both are separate
follow-up plans once this one is merged, mirroring how this project has always sequenced
engine → frontend → API-layer as separate plans. This plan is fully testable on its own: engine
tests hit a real local Postgres as they always have, and `apps/api` tests mock the engine layer
exactly as `scene.test.ts`/`leaderboard.test.ts` already do — no live Stripe account or
deployed cluster is needed to finish and verify this plan.

**Design note — this plan supersedes and refines one part of the spec.** The approved spec
(`docs/superpowers/specs/2026-09-22-stripe-payment-integration-design.md`, Section 3) described
refunding losers by iterating `RoundParticipant` rows directly. The actual existing code
(`apps/engine/src/engine/roundResolution.ts`) is more involved than that: it already implements
a **cascade** — if the winning bidder's payment fails, their deposit is forfeited, they're
banned, and the payment offer moves to the next-highest bidder, repeating until someone pays or
the queue is exhausted. This plan keeps that cascade mechanic (it is existing, reviewed,
merged, tested behavior — no product decision changes it), but re-points it at
`roundParticipants` instead of `bids`, and — because the remainder charge is now automatic and
off-session instead of something the engine waits for a user to interactively confirm — merges
the two functions that used to split this into "user pays in time" (`confirmPayment`) vs. "user
never paid in time" (`resolveExpiredOffer`) into one function, `attemptOfferPayment`, that
attempts the charge immediately and handles both outcomes. See Task 7 for the full rationale
and code.

## Global Constraints

- All user-facing UI text is English (not touched by this plan — no UI here — but any
  API-facing error strings should still read as English copy, consistent with the rest of the
  codebase).
- Money is always integer cents end-to-end.
- Non-payment after winning results in a ban (`BAN_ROUNDS` = 3 rounds, from
  `apps/engine/src/domain/config.ts`), including when the trigger is a card requiring extra
  authentication (Stripe `requires_action`) rather than an outright decline. No exception path.
- Deposit amount is fixed per round: `calculateDeposit(reign.priceCents)`, computed once from
  the price the champion held when the round opened — never recomputed from an individual bid.
- A bidder pays the deposit once per round (via `joinRound`) and may then place or raise bids
  any number of times for free within that round.
- `bidderId` remains an opaque, caller-supplied string throughout — exactly as it already is
  in every existing engine function. No authentication/identity system exists yet (Google/Apple
  OAuth is explicitly paused); this plan does not add one. The new API routes trust the
  `bidderId` given in the request body, matching the trust model the rest of the codebase
  already has.
- Follow the codebase's existing claim-before-act idempotency pattern (a single conditional
  `UPDATE ... WHERE status = 'pending'`, or a unique-constraint `INSERT`) for every new
  state transition that a duplicate Stripe webhook delivery could otherwise double-apply.

---

### Task 1: Schema — `roundParticipants` table, strip deposit fields off `bids`

**Files:**
- Modify: `apps/engine/src/db/schema.ts`
- Test: `apps/engine/tests/db/schema.test.ts`

**Interfaces:**
- Produces: `roundParticipants` table (Drizzle table object), exported `RoundParticipant`
  type (added in Task 4, but the table itself is this task's deliverable). Row shape:
  `{ id: string; roundId: string; bidderId: string; depositCents: number; depositRef: string; paymentMethodRef: string; depositStatus: "held"|"refunded"|"forfeited"|"applied"; joinedAt: Date }`.
  Unique on `(roundId, bidderId)` — this is the idempotency backbone Task 5's `joinRound` relies
  on to detect a duplicate webhook delivery.
- Consumes: nothing new (uses the existing `depositStatusEnum`).

- [ ] **Step 1: Update the schema file**

Replace the full contents of `apps/engine/src/db/schema.ts` with:

```ts
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
// off-session remainder charge if this bidder wins.
export const roundParticipants = pgTable("round_participants", {
  id: uuid("id").defaultRandom().primaryKey(),
  roundId: uuid("round_id").notNull().references(() => rounds.id),
  bidderId: text("bidder_id").notNull(),
  depositCents: integer("deposit_cents").notNull(),
  depositRef: text("deposit_ref").notNull(),
  paymentMethodRef: text("payment_method_ref").notNull(),
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
```

- [ ] **Step 2: Push the schema to the local dev/test database**

Run: `npm run db:push --workspace=apps/engine`

This is drizzle-kit's schema-push flow (no versioned migrations exist in this project yet —
confirmed by the absence of a `drizzle/` migrations directory alongside `drizzle.config.ts`).
It will prompt about the `bids` table losing three columns (`deposit_cents`, `deposit_ref`,
`deposit_status`) — confirm the drop; there is no production data to preserve yet.

- [ ] **Step 3: Add a smoke test for the new table**

Add to `apps/engine/tests/db/schema.test.ts` (append inside the existing `describe("schema", ...)` block, after the `reigns` test):

```ts
  it("can insert and read a round participant, and rejects a duplicate (roundId, bidderId)", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "u1", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();

    const [inserted] = await db
      .insert(roundParticipants)
      .values({ roundId: round.id, bidderId: "bidder-1", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1" })
      .returning();
    expect(inserted.depositStatus).toBe("held");

    await expect(
      db.insert(roundParticipants).values({ roundId: round.id, bidderId: "bidder-1", depositCents: 1_000, depositRef: "pi_2", paymentMethodRef: "pm_2" }),
    ).rejects.toThrow();

    await db.delete(roundParticipants).where(eq(roundParticipants.id, inserted.id));
    await db.delete(rounds).where(eq(rounds.id, round.id));
    await db.delete(reigns).where(eq(reigns.id, reign.id));
  });
```

Update the file's import line to include the new table:

```ts
import { reigns, rounds, roundParticipants } from "../../src/db/schema";
```

- [ ] **Step 4: Run the tests**

Run: `npm test --workspace=apps/engine -- schema.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/engine/src/db/schema.ts apps/engine/tests/db/schema.test.ts
git commit -m "feat(engine): add roundParticipants table, remove per-bid deposit columns"
```

---

### Task 2: `calculateDeposit` — derive from round-open price, not bid amount

**Files:**
- Modify: `apps/engine/src/domain/deposit.ts`
- Test: `apps/engine/tests/domain/deposit.test.ts`

**Interfaces:**
- Produces: `calculateDeposit(roundOpenPriceCents: number): number` (same formula and cap as
  before — `Math.min(DEPOSIT_CAP_CENTS, Math.round(roundOpenPriceCents * DEPOSIT_PERCENT))` —
  only the meaning of the parameter changes, not the math).
- Consumes: `DEPOSIT_PERCENT`, `DEPOSIT_CAP_CENTS` from `../domain/config` (unchanged).

- [ ] **Step 1: Update the failing/changed tests first**

Replace `apps/engine/tests/domain/deposit.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { calculateDeposit } from "../../src/domain/deposit";

describe("calculateDeposit", () => {
  it("is 10% of the round's opening price", () => {
    expect(calculateDeposit(10_000)).toBe(1_000);
  });

  it("rounds to the nearest cent", () => {
    expect(calculateDeposit(10_005)).toBe(1_001); // 1000.5 rounds up
  });

  it("caps at $1,000 (100,000 cents)", () => {
    expect(calculateDeposit(50_000_000)).toBe(100_000);
  });

  it("is exactly the cap at the boundary", () => {
    expect(calculateDeposit(1_000_000)).toBe(100_000);
  });
});
```

- [ ] **Step 2: Run to confirm current behavior still matches (this is a rename, not a logic change)**

Run: `npm test --workspace=apps/engine -- deposit.test.ts`
Expected: PASS (the implementation doesn't need to change yet — Step 3 is a pure rename for clarity)

- [ ] **Step 3: Rename the parameter for clarity**

Replace `apps/engine/src/domain/deposit.ts` with:

```ts
import { DEPOSIT_PERCENT, DEPOSIT_CAP_CENTS } from "./config";

export function calculateDeposit(roundOpenPriceCents: number): number {
  return Math.min(DEPOSIT_CAP_CENTS, Math.round(roundOpenPriceCents * DEPOSIT_PERCENT));
}
```

- [ ] **Step 4: Run tests again**

Run: `npm test --workspace=apps/engine -- deposit.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/engine/src/domain/deposit.ts apps/engine/tests/domain/deposit.test.ts
git commit -m "refactor(engine): clarify calculateDeposit takes the round's opening price"
```

---

### Task 3: Shrink `PaymentProvider`, rewrite `FakePaymentProvider`

**Files:**
- Modify: `apps/engine/src/payments/PaymentProvider.ts`
- Modify: `apps/engine/src/payments/FakePaymentProvider.ts`
- Test: `apps/engine/tests/payments/FakePaymentProvider.test.ts`

**Interfaces:**
- Produces:
  - `interface PaymentProvider { chargeRemainderOffSession(paymentMethodRef: string, amountCents: number): Promise<"succeeded"|"requires_action"|"failed">; refund(depositRef: string): Promise<void>; }`
  - `class FakePaymentProvider implements PaymentProvider` with public arrays
    `remainderCharges: { paymentMethodRef: string; amountCents: number }[]` and
    `refunds: string[]`, plus `failNextRemainderCharge(result?: "requires_action"|"failed"): void`
    to script the next `chargeRemainderOffSession` call's result (defaults to `"failed"`).
- Consumes: nothing.

- [ ] **Step 1: Update `PaymentProvider.ts`**

Replace `apps/engine/src/payments/PaymentProvider.ts` with:

```ts
export interface PaymentProvider {
  // Off-session because the engine itself initiates this — no bidder is
  // present in a browser at the moment a round resolves. paymentMethodRef is
  // the Stripe PaymentMethod id saved when this bidder paid their deposit
  // (see joinRound). "requires_action" covers a bank declining the charge
  // pending additional authentication (SCA/PSD2) — treated identically to
  // "failed" by every caller in this codebase; see roundResolution.ts.
  chargeRemainderOffSession(paymentMethodRef: string, amountCents: number): Promise<"succeeded" | "requires_action" | "failed">;
  refund(depositRef: string): Promise<void>;
}
```

- [ ] **Step 2: Update the test file first**

Replace `apps/engine/tests/payments/FakePaymentProvider.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";

describe("FakePaymentProvider", () => {
  it("charges the remainder successfully by default and records it", async () => {
    const provider = new FakePaymentProvider();
    const result = await provider.chargeRemainderOffSession("pm_1", 9_000);
    expect(result).toBe("succeeded");
    expect(provider.remainderCharges).toEqual([{ paymentMethodRef: "pm_1", amountCents: 9_000 }]);
  });

  it("fails the next remainder charge on request (defaulting to 'failed'), then resets", async () => {
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge();
    expect(await provider.chargeRemainderOffSession("pm_1", 9_000)).toBe("failed");
    expect(await provider.chargeRemainderOffSession("pm_1", 9_000)).toBe("succeeded");
  });

  it("can script a 'requires_action' result specifically", async () => {
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("requires_action");
    expect(await provider.chargeRemainderOffSession("pm_1", 9_000)).toBe("requires_action");
  });

  it("tracks refunds", async () => {
    const provider = new FakePaymentProvider();
    await provider.refund("pi_1");
    expect(provider.refunds).toEqual(["pi_1"]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test --workspace=apps/engine -- FakePaymentProvider.test.ts`
Expected: FAIL (old `FakePaymentProvider` doesn't have `chargeRemainderOffSession`/`remainderCharges`/`failNextRemainderCharge(result)`)

- [ ] **Step 4: Rewrite the implementation**

Replace `apps/engine/src/payments/FakePaymentProvider.ts` with:

```ts
import type { PaymentProvider } from "./PaymentProvider";

export class FakePaymentProvider implements PaymentProvider {
  remainderCharges: { paymentMethodRef: string; amountCents: number }[] = [];
  refunds: string[] = [];
  private nextRemainderResult: "succeeded" | "requires_action" | "failed" = "succeeded";

  async chargeRemainderOffSession(paymentMethodRef: string, amountCents: number): Promise<"succeeded" | "requires_action" | "failed"> {
    this.remainderCharges.push({ paymentMethodRef, amountCents });
    const result = this.nextRemainderResult;
    this.nextRemainderResult = "succeeded";
    return result;
  }

  async refund(depositRef: string): Promise<void> {
    this.refunds.push(depositRef);
  }

  failNextRemainderCharge(result: "requires_action" | "failed" = "failed"): void {
    this.nextRemainderResult = result;
  }
}
```

- [ ] **Step 5: Run tests again**

Run: `npm test --workspace=apps/engine -- FakePaymentProvider.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/engine/src/payments/PaymentProvider.ts apps/engine/src/payments/FakePaymentProvider.ts apps/engine/tests/payments/FakePaymentProvider.test.ts
git commit -m "feat(engine): shrink PaymentProvider to remainder-charge + refund, rewrite fake"
```

---

### Task 4: `repository.ts` — `RoundParticipant` helpers, `placeBidAtomic` rework

**Files:**
- Modify: `apps/engine/src/db/repository.ts`
- Test: `apps/engine/tests/db/repository.test.ts`
- Test: `apps/engine/tests/db/repository.placeBidAtomic.test.ts`

**Interfaces:**
- Consumes: `roundParticipants` table (Task 1), `PaymentProvider` (Task 3, type-only — not used
  here, just noting the shrunk shape is now the only one in the codebase).
- Produces:
  - `type RoundParticipant = typeof roundParticipants.$inferSelect`
  - `getRoundParticipant(roundId: string, bidderId: string): Promise<RoundParticipant | null>`
  - `placeBidAtomic(params: { roundId: string; bidderId: string; amountCents: number; placedAt?: Date; onRetry?: () => void }): Promise<{ ok: true; bid: Bid } | { ok: false; reason: string }>`
    — same shape as before, minus `depositCents`/`depositRef` params, plus an authoritative
    "has this bidder joined this round?" check inside the transaction.

- [ ] **Step 1: Update `repository.test.ts` first — strip deposit fields from every `bids` insert**

In `apps/engine/tests/db/repository.test.ts`, remove `depositCents` and `depositRef` from every
`db.insert(bids).values(...)` call in the `getQueueLeader` describe block. The three inserts
become:

```ts
    await db.insert(bids).values([
      { roundId: round.id, bidderId: "a", amountCents: 11_000, placedAt: new Date(2026, 0, 1, 10, 0, 1) },
      { roundId: round.id, bidderId: "b", amountCents: 12_000, placedAt: new Date(2026, 0, 1, 10, 0, 2) },
      { roundId: round.id, bidderId: "c", amountCents: 12_000, placedAt: new Date(2026, 0, 1, 10, 0, 0) },
    ]);
```

and

```ts
    await db.insert(bids).values([
      { roundId: round.id, bidderId: "in-window", amountCents: 11_000, placedAt: new Date(windowClose.getTime() - 1000) },
      { roundId: round.id, bidderId: "late", amountCents: 99_000, placedAt: new Date(windowClose.getTime() + 1000) },
    ]);
```

(No other part of this file changes — `getCurrentReign`, `getLatestRound`, `isBanned` are untouched.)

- [ ] **Step 2: Add `getRoundParticipant` tests**

Append a new `describe` block to `apps/engine/tests/db/repository.test.ts`:

```ts
describe("getRoundParticipant", () => {
  it("returns null when the bidder hasn't joined this round", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "u1", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();
    expect(await getRoundParticipant(round.id, "nobody")).toBeNull();
  });

  it("returns the participant row once joined", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "u1", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();
    await db.insert(roundParticipants).values({ roundId: round.id, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1" });

    const participant = await getRoundParticipant(round.id, "a");
    expect(participant?.depositStatus).toBe("held");
    expect(participant?.depositCents).toBe(1_000);
  });
});
```

Update the file's imports at the top:

```ts
import { reigns, rounds, bids, bans, roundParticipants } from "../../src/db/schema";
import { getCurrentReign, getLatestRound, getQueueLeader, isBanned, getRoundParticipant } from "../../src/db/repository";
```

And its `afterEach` to also clean up the new table:

```ts
afterEach(async () => {
  await db.delete(roundParticipants);
  await db.delete(bids);
  await db.delete(bans);
  await db.delete(rounds);
  await db.delete(reigns);
});
```

- [ ] **Step 3: Update `repository.placeBidAtomic.test.ts` first — strip deposit params, seed a `RoundParticipant`**

Replace `apps/engine/tests/db/repository.placeBidAtomic.test.ts` with:

```ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, roundParticipants } from "../../src/db/schema";
import { placeBidAtomic } from "../../src/db/repository";

afterEach(async () => {
  await db.delete(roundParticipants);
  await db.delete(bids);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

async function seedRound(priceCents: number, phase: "bidding" | "payment" | "closed" = "bidding") {
  const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents, startedAt: new Date() }).returning();
  const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date(), phase }).returning();
  return round.id;
}

async function join(roundId: string, bidderId: string) {
  await db.insert(roundParticipants).values({ roundId, bidderId, depositCents: 1_000, depositRef: `pi_${bidderId}`, paymentMethodRef: `pm_${bidderId}` });
}

describe("placeBidAtomic", () => {
  it("accepts a valid first bid against the champion price from a joined bidder", async () => {
    const roundId = await seedRound(10_000);
    await join(roundId, "a");
    const result = await placeBidAtomic({ roundId, bidderId: "a", amountCents: 10_100 });
    expect(result.ok).toBe(true);
  });

  it("rejects a bid from a bidder who hasn't joined this round", async () => {
    const roundId = await seedRound(10_000);
    const result = await placeBidAtomic({ roundId, bidderId: "a", amountCents: 10_100 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("Join this round");
  });

  it("rejects a bid that doesn't beat the champion by the minimum increment", async () => {
    const roundId = await seedRound(10_000);
    await join(roundId, "a");
    const result = await placeBidAtomic({ roundId, bidderId: "a", amountCents: 10_050 });
    expect(result.ok).toBe(false);
  });

  it("rejects a bid that doesn't beat the current queue leader", async () => {
    const roundId = await seedRound(10_000);
    await join(roundId, "a");
    await join(roundId, "b");
    await placeBidAtomic({ roundId, bidderId: "a", amountCents: 11_000 });
    const second = await placeBidAtomic({ roundId, bidderId: "b", amountCents: 11_050 });
    expect(second.ok).toBe(false);
  });

  it("accepts a bid that beats the current queue leader", async () => {
    const roundId = await seedRound(10_000);
    await join(roundId, "a");
    await join(roundId, "b");
    await placeBidAtomic({ roundId, bidderId: "a", amountCents: 11_000 });
    const second = await placeBidAtomic({ roundId, bidderId: "b", amountCents: 11_100 });
    expect(second.ok).toBe(true);
  });

  it("allows the same joined bidder to raise their own bid for free, more than once", async () => {
    const roundId = await seedRound(10_000);
    await join(roundId, "a");
    const first = await placeBidAtomic({ roundId, bidderId: "a", amountCents: 10_100 });
    expect(first.ok).toBe(true);
    const second = await placeBidAtomic({ roundId, bidderId: "a", amountCents: 10_200 });
    expect(second.ok).toBe(true);
  });

  it("rejects a bid against a round that has moved past the bidding phase", async () => {
    const paymentRoundId = await seedRound(10_000, "payment");
    await join(paymentRoundId, "a");
    const paymentResult = await placeBidAtomic({ roundId: paymentRoundId, bidderId: "a", amountCents: 10_100 });
    expect(paymentResult.ok).toBe(false);

    const closedRoundId = await seedRound(10_000, "closed");
    await join(closedRoundId, "a");
    const closedResult = await placeBidAtomic({ roundId: closedRoundId, bidderId: "a", amountCents: 10_100 });
    expect(closedResult.ok).toBe(false);
  });

  it("only lets one of two simultaneous equal-tier bids win the leader slot, via a genuine SERIALIZABLE conflict", async () => {
    const roundId = await seedRound(10_000);
    await join(roundId, "a");
    await join(roundId, "b");
    // Pre-warm two pool connections in parallel first. Without this, the second
    // placeBidAtomic call below can pay a cold `pool.connect()` penalty that lets
    // the first transaction fully commit before the second even starts its first
    // SELECT — the two calls end up serialized by accident (no SQLSTATE 40001 ever
    // fires) rather than genuinely racing inside Postgres's SERIALIZABLE isolation.
    await Promise.all([db.execute(sql`select 1`), db.execute(sql`select 1`)]);

    let retryCount = 0;
    const onRetry = () => {
      retryCount += 1;
    };

    const [r1, r2] = await Promise.all([
      placeBidAtomic({ roundId, bidderId: "a", amountCents: 10_100, onRetry }),
      placeBidAtomic({ roundId, bidderId: "b", amountCents: 10_100, onRetry }),
    ]);
    const okCount = [r1, r2].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    expect(retryCount).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 4: Run to verify both test files fail**

Run: `npm test --workspace=apps/engine -- repository.test.ts repository.placeBidAtomic.test.ts`
Expected: FAIL (`getRoundParticipant` doesn't exist yet; `placeBidAtomic` still requires `depositCents`/`depositRef`)

- [ ] **Step 5: Implement**

Replace `apps/engine/src/db/repository.ts` with:

```ts
import { and, desc, asc, eq, gt, lte, isNull } from "drizzle-orm";
import { db } from "./client";
import { reigns, rounds, bids, bans, roundParticipants } from "./schema";
import { validateBidAmount } from "../domain/bidValidation";

export type Reign = typeof reigns.$inferSelect;
export type Round = typeof rounds.$inferSelect;
export type Bid = typeof bids.$inferSelect;
export type RoundParticipant = typeof roundParticipants.$inferSelect;

export async function getCurrentReign(): Promise<Reign | null> {
  const [reign] = await db.select().from(reigns).where(isNull(reigns.endedAt)).limit(1);
  return reign ?? null;
}

export async function getLatestRound(reignId: string): Promise<Round | null> {
  const [round] = await db
    .select()
    .from(rounds)
    .where(eq(rounds.reignId, reignId))
    .orderBy(desc(rounds.startsAt))
    .limit(1);
  return round ?? null;
}

export async function getQueueLeader(roundId: string, asOf?: Date): Promise<Bid | null> {
  const where = asOf ? and(eq(bids.roundId, roundId), lte(bids.placedAt, asOf)) : eq(bids.roundId, roundId);
  const [top] = await db
    .select()
    .from(bids)
    .where(where)
    .orderBy(desc(bids.amountCents), asc(bids.placedAt))
    .limit(1);
  return top ?? null;
}

export async function getRoundParticipant(roundId: string, bidderId: string): Promise<RoundParticipant | null> {
  const [row] = await db
    .select()
    .from(roundParticipants)
    .where(and(eq(roundParticipants.roundId, roundId), eq(roundParticipants.bidderId, bidderId)))
    .limit(1);
  return row ?? null;
}

export async function isBanned(bidderId: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select()
    .from(bans)
    .where(and(eq(bans.bidderId, bidderId), gt(bans.bannedUntil, now)))
    .limit(1);
  return !!row;
}

const SERIALIZATION_FAILURE = "40001";

export async function placeBidAtomic(params: {
  roundId: string;
  bidderId: string;
  amountCents: number;
  // When omitted the column's DEFAULT now() (the database clock) is used.
  placedAt?: Date;
  onRetry?: () => void;
}): Promise<{ ok: true; bid: Bid } | { ok: false; reason: string }> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await db.transaction(
        async (tx) => {
          const [round] = await tx.select().from(rounds).where(eq(rounds.id, params.roundId)).limit(1);
          if (!round) return { ok: false, reason: "Round not found." };
          if (round.phase !== "bidding") return { ok: false, reason: "Round is not accepting bids." };

          const [reign] = await tx.select().from(reigns).where(eq(reigns.id, round.reignId)).limit(1);
          if (!reign) return { ok: false, reason: "Reign not found." };

          // Authoritative check: fast-path duplicate of this lives in placeBid.ts,
          // but this is the one that actually guards correctness inside the
          // transaction, same rationale as the amount/phase checks above it.
          const [participant] = await tx
            .select()
            .from(roundParticipants)
            .where(and(eq(roundParticipants.roundId, params.roundId), eq(roundParticipants.bidderId, params.bidderId)))
            .limit(1);
          if (!participant || participant.depositStatus !== "held") {
            return { ok: false, reason: "Join this round (pay the deposit) before placing a bid." };
          }

          const [topBid] = await tx
            .select()
            .from(bids)
            .where(eq(bids.roundId, params.roundId))
            .orderBy(desc(bids.amountCents), asc(bids.placedAt))
            .limit(1);

          const currentLeaderCents = topBid ? topBid.amountCents : reign.priceCents;
          const validation = validateBidAmount(params.amountCents, currentLeaderCents);
          if (!validation.valid) return { ok: false, reason: validation.reason };

          const [inserted] = await tx
            .insert(bids)
            .values({
              roundId: params.roundId,
              bidderId: params.bidderId,
              amountCents: params.amountCents,
              ...(params.placedAt ? { placedAt: params.placedAt } : {}),
            })
            .returning();

          return { ok: true, bid: inserted };
        },
        { isolationLevel: "serializable" },
      );
    } catch (err: any) {
      if (err?.code === SERIALIZATION_FAILURE && attempt < maxAttempts) {
        params.onRetry?.();
        continue;
      }
      throw err;
    }
  }
  throw new Error("placeBidAtomic: exceeded retry attempts under serialization conflict");
}
```

- [ ] **Step 6: Run tests**

Run: `npm test --workspace=apps/engine -- repository.test.ts repository.placeBidAtomic.test.ts`
Expected: PASS (all tests)

- [ ] **Step 7: Commit**

```bash
git add apps/engine/src/db/repository.ts apps/engine/tests/db/repository.test.ts apps/engine/tests/db/repository.placeBidAtomic.test.ts
git commit -m "feat(engine): add getRoundParticipant, gate placeBidAtomic on joining the round"
```

---

### Task 5: `joinRound` — the once-per-round deposit entry point

**Files:**
- Create: `apps/engine/src/engine/joinRound.ts`
- Test: `apps/engine/tests/engine/joinRound.test.ts`

**Interfaces:**
- Consumes: `roundParticipants`, `rounds` (schema, Task 1), `PaymentProvider` (Task 3).
- Produces:
  `joinRound(params: { roundId: string; bidderId: string; depositCents: number; depositRef: string; paymentMethodRef: string; now: Date }, provider: PaymentProvider): Promise<{ outcome: "joined" | "already-joined" | "refunded-round-closed" }>`
  — called only after a deposit PaymentIntent has already succeeded (from the `apps/api`
  webhook handler, Task 13). Idempotent: a duplicate call with data that collides on
  `(roundId, bidderId)` returns `"already-joined"` instead of erroring or double-crediting.

- [ ] **Step 1: Write the failing tests**

Create `apps/engine/tests/engine/joinRound.test.ts`:

```ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, roundParticipants } from "../../src/db/schema";
import { joinRound } from "../../src/engine/joinRound";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";

afterEach(async () => {
  await db.delete(roundParticipants);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

async function seedRound(phase: "bidding" | "resolving" | "payment" | "closed" = "bidding") {
  const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: new Date() }).returning();
  const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date(), phase }).returning();
  return round.id;
}

describe("joinRound", () => {
  it("creates a held round participant on first call", async () => {
    const roundId = await seedRound();
    const provider = new FakePaymentProvider();

    const result = await joinRound(
      { roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() },
      provider,
    );

    expect(result.outcome).toBe("joined");
    const [row] = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    expect(row.bidderId).toBe("a");
    expect(row.depositStatus).toBe("held");
    expect(provider.refunds).toHaveLength(0);
  });

  it("is idempotent — a duplicate call for the same (roundId, bidderId) is a safe no-op", async () => {
    const roundId = await seedRound();
    const provider = new FakePaymentProvider();

    await joinRound({ roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() }, provider);
    const second = await joinRound(
      { roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_2", paymentMethodRef: "pm_2", now: new Date() },
      provider,
    );

    expect(second.outcome).toBe("already-joined");
    const rows = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    expect(rows).toHaveLength(1);
  });

  it("two concurrent calls for the same (roundId, bidderId) resolve to exactly one 'joined'", async () => {
    const roundId = await seedRound();
    const provider = new FakePaymentProvider();

    const [a, b] = await Promise.all([
      joinRound({ roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() }, provider),
      joinRound({ roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_2", paymentMethodRef: "pm_2", now: new Date() }, provider),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["already-joined", "joined"]);
  });

  it("refunds immediately and does not grant bidding rights when the round already left the bidding phase", async () => {
    // A genuine race: the round can snapshot/close between the user clicking
    // "Join" and Stripe's webhook actually arriving. The deposit was already
    // charged — it must not be stranded as a "held" row nothing will ever
    // resolve.
    const roundId = await seedRound("resolving");
    const provider = new FakePaymentProvider();

    const result = await joinRound(
      { roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() },
      provider,
    );

    expect(result.outcome).toBe("refunded-round-closed");
    expect(provider.refunds).toEqual(["pi_1"]);
    const [row] = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    expect(row.depositStatus).toBe("refunded");
  });

  it("throws if the round does not exist", async () => {
    const provider = new FakePaymentProvider();
    await expect(
      joinRound(
        { roundId: "00000000-0000-0000-0000-000000000000", bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() },
        provider,
      ),
    ).rejects.toThrow("Round not found");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace=apps/engine -- joinRound.test.ts`
Expected: FAIL (`../../src/engine/joinRound` does not exist)

- [ ] **Step 3: Implement**

Create `apps/engine/src/engine/joinRound.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { rounds, roundParticipants } from "../db/schema";
import type { PaymentProvider } from "../payments/PaymentProvider";

const UNIQUE_VIOLATION = "23505";

export async function joinRound(
  params: {
    roundId: string;
    bidderId: string;
    depositCents: number;
    depositRef: string;
    paymentMethodRef: string;
    now: Date;
  },
  provider: PaymentProvider,
): Promise<{ outcome: "joined" | "already-joined" | "refunded-round-closed" }> {
  const [round] = await db.select().from(rounds).where(eq(rounds.id, params.roundId)).limit(1);
  if (!round) throw new Error("Round not found.");

  // The round can leave "bidding" between the user starting checkout and
  // Stripe's webhook actually confirming the charge (bidding-window close is
  // enforced on a 12h clock; webhook delivery is not instant). The deposit is
  // already charged by the time this function runs, so if that race happened,
  // record the participant as immediately refunded rather than silently
  // dropping money that was actually taken.
  const stillOpen = round.phase === "bidding";

  try {
    await db.insert(roundParticipants).values({
      roundId: params.roundId,
      bidderId: params.bidderId,
      depositCents: params.depositCents,
      depositRef: params.depositRef,
      paymentMethodRef: params.paymentMethodRef,
      depositStatus: stillOpen ? "held" : "refunded",
      joinedAt: params.now,
    });
  } catch (err: any) {
    if (err?.code === UNIQUE_VIOLATION) {
      // Stripe redelivered the payment_intent.succeeded webhook for a bidder
      // who already joined — safe no-op, not an error.
      return { outcome: "already-joined" };
    }
    throw err;
  }

  if (!stillOpen) {
    await provider.refund(params.depositRef);
    return { outcome: "refunded-round-closed" };
  }

  return { outcome: "joined" };
}
```

Note: `(and, eq)` import is unused in this exact file (only `eq` is), so import only `eq`:

```ts
import { eq } from "drizzle-orm";
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=apps/engine -- joinRound.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/engine/src/engine/joinRound.ts apps/engine/tests/engine/joinRound.test.ts
git commit -m "feat(engine): add joinRound, the once-per-round deposit entry point"
```

---

### Task 6: `placeBid` — drop `PaymentProvider`, require joining first

**Files:**
- Modify: `apps/engine/src/engine/placeBid.ts`
- Test: `apps/engine/tests/engine/placeBid.test.ts`
- Test: `apps/engine/tests/engine/placeBid.atomicFailure.test.ts`

**Interfaces:**
- Consumes: `getRoundParticipant` (Task 4), `placeBidAtomic` (Task 4, new signature).
- Produces: `placeBid(params: { bidderId: string; amountCents: number; now: Date }): Promise<{ ok: true; bidId: string } | { ok: false; reason: string }>`
  — no `PaymentProvider` parameter at all; no return-value `depositCents` (nothing was charged
  here to report).

- [ ] **Step 1: Update `placeBid.test.ts` first**

Replace `apps/engine/tests/engine/placeBid.test.ts` with:

```ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans, roundParticipants } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { placeBid } from "../../src/engine/placeBid";
import { getLatestRound } from "../../src/db/repository";
import { BIDDING_PHASE_MS, MAX_BID_CENTS } from "../../src/domain/config";

afterEach(async () => {
  await db.delete(roundParticipants);
  await db.delete(bids);
  await db.delete(bans);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

async function join(roundId: string, bidderId: string) {
  await db.insert(roundParticipants).values({ roundId, bidderId, depositCents: 1_000, depositRef: `pi_${bidderId}`, paymentMethodRef: `pm_${bidderId}` });
}

async function currentRoundId(reignId: string): Promise<string> {
  const round = await getLatestRound(reignId);
  return round!.id;
}

describe("placeBid", () => {
  it("records the bid for a bidder who already joined the round", async () => {
    const reign = await createInitialReign("champ", new Date(2026, 0, 1));
    await join(await currentRoundId(reign.id), "challenger");

    const result = await placeBid({ bidderId: "challenger", amountCents: 10_100, now: new Date(2026, 0, 1, 1) });
    expect(result.ok).toBe(true);
  });

  it("rejects a bid from a bidder who has not joined the round", async () => {
    await createInitialReign("champ", new Date(2026, 0, 1));
    const result = await placeBid({ bidderId: "challenger", amountCents: 10_100, now: new Date(2026, 0, 1, 1) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("Join this round");
  });

  it("rejects a bid below the minimum increment", async () => {
    const reign = await createInitialReign("champ", new Date(2026, 0, 1));
    await join(await currentRoundId(reign.id), "challenger");
    const result = await placeBid({ bidderId: "challenger", amountCents: 10_050, now: new Date(2026, 0, 1, 1) });
    expect(result.ok).toBe(false);
  });

  it("rejects a bid from a banned bidder", async () => {
    const reign = await createInitialReign("champ", new Date(2026, 0, 1));
    await join(await currentRoundId(reign.id), "challenger");
    await db.insert(bans).values({ bidderId: "challenger", bannedUntil: new Date(2026, 0, 10) });
    const result = await placeBid({ bidderId: "challenger", amountCents: 20_000, now: new Date(2026, 0, 1, 1) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("banned");
  });

  it("rejects a bid before the round's startsAt has arrived", async () => {
    const reign = await createInitialReign("champ", new Date(2026, 0, 1));
    const futureStartsAt = new Date(2026, 0, 2, 0, 0, 0);
    const [futureRound] = await db.insert(rounds).values({ reignId: reign.id, startsAt: futureStartsAt, phase: "bidding" }).returning();
    await join(futureRound.id, "challenger");

    const result = await placeBid({ bidderId: "challenger", amountCents: 20_000, now: new Date(futureStartsAt.getTime() - 1000) });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("not accepting bids");
  });

  it("rejects a bid placed after the bidding window closed", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    await join(await currentRoundId(reign.id), "sniper");

    const result = await placeBid({
      bidderId: "sniper",
      amountCents: 20_000,
      now: new Date(startsAt.getTime() + BIDDING_PHASE_MS + 3 * 60 * 60 * 1000),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("not accepting bids");
    expect(await db.select().from(bids)).toHaveLength(0);
  });

  it("accepts a bid in the last millisecond of the window and rejects one exactly at the close", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    await join(roundId, "early");
    await join(roundId, "late");
    const closesAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);

    const justInside = await placeBid({ bidderId: "early", amountCents: 10_100, now: new Date(closesAt.getTime() - 1) });
    expect(justInside.ok).toBe(true);

    const atClose = await placeBid({ bidderId: "late", amountCents: 20_000, now: closesAt });
    expect(atClose.ok).toBe(false);
  });

  it("rejects a NaN amount", async () => {
    const reign = await createInitialReign("champ", new Date(2026, 0, 1));
    await join(await currentRoundId(reign.id), "challenger");

    const result = await placeBid({ bidderId: "challenger", amountCents: NaN, now: new Date(2026, 0, 1, 1) });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("whole number");
    expect(await db.select().from(bids)).toHaveLength(0);
  });

  it("rejects an amount above MAX_BID_CENTS", async () => {
    const reign = await createInitialReign("champ", new Date(2026, 0, 1));
    await join(await currentRoundId(reign.id), "challenger");

    const result = await placeBid({ bidderId: "challenger", amountCents: 3_000_000_000, now: new Date(2026, 0, 1, 1) });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain(String(MAX_BID_CENTS));
    expect(await db.select().from(bids)).toHaveLength(0);
  });

  it("allows a joined bidder to raise their own bid more than once, for free", async () => {
    const reign = await createInitialReign("champ", new Date(2026, 0, 1));
    await join(await currentRoundId(reign.id), "challenger");
    const now = new Date(2026, 0, 1, 1);

    const first = await placeBid({ bidderId: "challenger", amountCents: 10_100, now });
    expect(first.ok).toBe(true);
    const second = await placeBid({ bidderId: "challenger", amountCents: 10_300, now });
    expect(second.ok).toBe(true);
    expect(await db.select().from(bids)).toHaveLength(2);
  });

  it("only lets one of two joined bidders win a concurrent equal-tier bid", async () => {
    const reign = await createInitialReign("champ", new Date(2026, 0, 1));
    const roundId = await currentRoundId(reign.id);
    await join(roundId, "a");
    await join(roundId, "b");
    const now = new Date(2026, 0, 1, 1);

    await Promise.all([db.execute(sql`select 1`), db.execute(sql`select 1`)]);

    const [a, b] = await Promise.all([
      placeBid({ bidderId: "a", amountCents: 10_100, now }),
      placeBid({ bidderId: "b", amountCents: 10_100, now }),
    ]);

    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Replace `placeBid.atomicFailure.test.ts`**

Replace `apps/engine/tests/engine/placeBid.atomicFailure.test.ts` with:

```ts
// Isolated in its own file because it mocks the repository module: placeBidAtomic
// is forced to throw so placeBid's error path can be exercised without a
// clean way to provoke a genuine throw from a healthy database.
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";

vi.mock("../../src/db/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/repository")>();
  return {
    ...actual,
    placeBidAtomic: vi.fn(async () => {
      throw new Error("simulated database failure inside placeBidAtomic");
    }),
  };
});

import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans, roundParticipants } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { placeBid } from "../../src/engine/placeBid";
import { getLatestRound } from "../../src/db/repository";

afterEach(async () => {
  await db.delete(roundParticipants);
  await db.delete(bids);
  await db.delete(bans);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

describe("placeBid when placeBidAtomic throws", () => {
  it("propagates the failure — nothing was charged here, so there is nothing to refund", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const round = await getLatestRound(reign.id);
    await db.insert(roundParticipants).values({ roundId: round!.id, bidderId: "challenger", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1" });

    await expect(
      placeBid({ bidderId: "challenger", amountCents: 11_000, now: new Date(startsAt.getTime() + 1000) }),
    ).rejects.toThrow("simulated database failure");

    expect(await db.select().from(bids)).toHaveLength(0);
  });
});
```

This test's meaning changed deliberately: under the old design, `placeBid` charged a deposit
*before* calling `placeBidAtomic`, so a throw from `placeBidAtomic` had to be caught and the
already-charged deposit refunded. Under the new design `placeBid` never charges anything —
deposits are collected once, up front, by `joinRound` — so a throw from `placeBidAtomic` has
nothing to compensate for and can propagate directly, exactly like every other engine function
that isn't guarding a side effect.

- [ ] **Step 3: Run to verify both test files fail**

Run: `npm test --workspace=apps/engine -- placeBid.test.ts placeBid.atomicFailure.test.ts`
Expected: FAIL (`placeBid` still requires a `PaymentProvider` second argument and charges a deposit)

- [ ] **Step 4: Implement**

Replace `apps/engine/src/engine/placeBid.ts` with:

```ts
import { getCurrentReign, getLatestRound, getQueueLeader, isBanned, getRoundParticipant, placeBidAtomic } from "../db/repository";
import { validateBidAmount } from "../domain/bidValidation";
import { BIDDING_PHASE_MS } from "../domain/config";

export async function placeBid(
  params: { bidderId: string; amountCents: number; now: Date },
): Promise<{ ok: true; bidId: string } | { ok: false; reason: string }> {
  if (await isBanned(params.bidderId, params.now)) {
    return { ok: false, reason: "This bidder is currently banned from placing bids." };
  }

  const reign = await getCurrentReign();
  if (!reign) return { ok: false, reason: "No active reign — the auction hasn't been bootstrapped yet." };

  const round = await getLatestRound(reign.id);
  const biddingClosesAt = round && new Date(round.startsAt.getTime() + BIDDING_PHASE_MS);
  if (
    !round ||
    !biddingClosesAt ||
    round.phase !== "bidding" ||
    round.startsAt > params.now ||
    params.now.getTime() >= biddingClosesAt.getTime()
  ) {
    // Both ends of the [T0, T0+12h) bidding window are enforced here — see the
    // original rationale preserved from before this rework: the scheduler opens
    // next-day rounds ahead of their startsAt (lower bound), and a round keeps
    // phase "bidding" until the scheduler's tick actually snapshots it (upper
    // bound); round.startsAt is immutable once inserted so plain comparisons
    // are sufficient here — no claim-guard race to worry about.
    return { ok: false, reason: "This round is not accepting bids right now." };
  }

  // Fast-path: a bidder who never joined (or a bid amount that's obviously too
  // low) never reaches placeBidAtomic's SERIALIZABLE transaction. Not
  // authoritative — both checks are re-verified for real inside
  // placeBidAtomic, which is what actually guards correctness under
  // concurrency.
  const participant = await getRoundParticipant(round.id, params.bidderId);
  if (!participant || participant.depositStatus !== "held") {
    return { ok: false, reason: "Join this round (pay the deposit) before placing a bid." };
  }

  const topBid = await getQueueLeader(round.id);
  const currentLeaderCents = topBid ? topBid.amountCents : reign.priceCents;
  const preValidation = validateBidAmount(params.amountCents, currentLeaderCents);
  if (!preValidation.valid) {
    return { ok: false, reason: preValidation.reason };
  }

  const result = await placeBidAtomic({
    roundId: round.id,
    bidderId: params.bidderId,
    amountCents: params.amountCents,
    placedAt: params.now,
  });

  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }

  return { ok: true, bidId: result.bid.id };
}
```

- [ ] **Step 5: Run tests**

Run: `npm test --workspace=apps/engine -- placeBid.test.ts placeBid.atomicFailure.test.ts`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add apps/engine/src/engine/placeBid.ts apps/engine/tests/engine/placeBid.test.ts apps/engine/tests/engine/placeBid.atomicFailure.test.ts
git commit -m "feat(engine): placeBid no longer charges anything — gated on RoundParticipant"
```

---

### Task 7: `roundResolution.ts` — automatic off-session settlement

**Files:**
- Modify: `apps/engine/src/engine/roundResolution.ts`
- Test: `apps/engine/tests/engine/roundResolution.payment.test.ts`
- Test: `apps/engine/tests/engine/roundResolution.snapshot.test.ts`

**Interfaces:**
- Consumes: `roundParticipants` (Task 1), shrunk `PaymentProvider` (Task 3), `installChampion`
  (unchanged, `apps/engine/src/engine/installChampion.ts`).
- Produces:
  - `resolveBiddingPhaseSnapshot(roundId, snapshotAt, provider, executedAt?): Promise<{ outcome: "empty-closed" } | { outcome: "already-resolving" } | { outcome: "offer-created"; offerId: string }>`
    — same behavior as before, except the "offer-created" outcome now also returns the new
    offer's id (Task 8's scheduler needs it to attempt payment immediately), and the "born
    already expired" refund path now refunds `roundParticipants` instead of `bids`.
  - `attemptOfferPayment(offerId, now, provider, onInstalled?): Promise<{ outcome: "paid" } | { outcome: "cascaded"; nextOfferId: string } | { outcome: "round-closed" } | { outcome: "already-processed" }>`
    — **replaces both `confirmPayment` and `resolveExpiredOffer`**. See the rationale below.
  - `settleRound(offerId, now, provider, onInstalled?): Promise<{ outcome: "paid" } | { outcome: "round-closed" }>`
    — loops `attemptOfferPayment`, following cascades, until the round is settled one way or
    the other. This is what Task 8's scheduler actually calls.

**Why `confirmPayment` and `resolveExpiredOffer` merge into one function:** those two functions
used to encode two different real-world events — "the bidder came back and paid within the 1h
window" vs. "the window elapsed with no payment." That distinction only made sense when paying
was something a human did interactively. Now the remainder charge is off-session and
automatic: the moment a payment offer exists, the engine attempts the charge itself, and Stripe
returns a definitive synchronous result (`succeeded`, or a decline/`requires_action`) — there is
no more "the bidder didn't get around to it yet" state to wait out. `attemptOfferPayment` is
that single attempt-and-settle step; `paymentOffers.expiresAt` and the scheduler's existing
poll for overdue offers become a crash-recovery safety net (Task 8) for the rare case where the
process died between claiming an offer and finishing it — not a mechanism anything is expected
to hit in normal operation.

- [ ] **Step 1: Update `roundResolution.payment.test.ts` first**

Replace `apps/engine/tests/engine/roundResolution.payment.test.ts` with:

```ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans, paymentOffers, roundParticipants } from "../../src/db/schema";
import { resolveBiddingPhaseSnapshot, attemptOfferPayment, settleRound } from "../../src/engine/roundResolution";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";
import { eq } from "drizzle-orm";
import { PAYMENT_ATTEMPT_MS, BIDDING_PHASE_MS, ROUND_MS } from "../../src/domain/config";

afterEach(async () => {
  await db.delete(paymentOffers);
  await db.delete(roundParticipants);
  await db.delete(bids);
  await db.delete(bans);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

async function seedRoundWithOffer(startsAt: Date, bidAmount: number, depositCents = 1_000) {
  const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: startsAt }).returning();
  const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt, phase: "bidding" }).returning();
  await db.insert(roundParticipants).values({ roundId: round.id, bidderId: "a", depositCents, depositRef: "pi_a", paymentMethodRef: "pm_a" });
  const [bid] = await db
    .insert(bids)
    .values({ roundId: round.id, bidderId: "a", amountCents: bidAmount, placedAt: new Date(startsAt.getTime() + 1000) })
    .returning();
  const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);
  const snapshot = await resolveBiddingPhaseSnapshot(round.id, snapshotAt, new FakePaymentProvider());
  if (snapshot.outcome !== "offer-created") throw new Error("expected an offer to be created");
  return { reignId: reign.id, roundId: round.id, bid, offerId: snapshot.offerId, snapshotAt };
}

describe("attemptOfferPayment — success path", () => {
  it("installs the payer as the new champion and marks the offer paid", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, bid, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    const result = await attemptOfferPayment(offerId, now, provider);
    expect(result.outcome).toBe("paid");

    const [updatedOffer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, offerId));
    expect(updatedOffer.status).toBe("paid");

    const [updatedRound] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(updatedRound.phase).toBe("closed");

    expect(provider.remainderCharges).toHaveLength(1);
    expect(provider.remainderCharges[0].paymentMethodRef).toBe("pm_a");
    expect(provider.remainderCharges[0].amountCents).toBe(bid.amountCents - 1_000);
  });

  it("marks the winner's own deposit 'applied', not 'refunded' — it was credited, not returned", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    await attemptOfferPayment(offerId, now, provider);

    const [participant] = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    expect(participant.depositStatus).toBe("applied");
    expect(provider.refunds).not.toContain("pi_a");
  });

  it("refunds every other held participant in the round on payment", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(roundParticipants).values({ roundId, bidderId: "loser", depositCents: 1_050, depositRef: "pi_loser", paymentMethodRef: "pm_loser" });
    const provider = new FakePaymentProvider();
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    await attemptOfferPayment(offerId, now, provider);
    expect(provider.refunds).toContain("pi_loser");
  });

  it("a second concurrent call for the same offer is a safe no-op — never double-charges", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { offerId } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    const [first, second] = await Promise.all([
      attemptOfferPayment(offerId, now, provider),
      attemptOfferPayment(offerId, now, provider),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["already-processed", "paid"]);
    expect(provider.remainderCharges).toHaveLength(1);
  });
});

describe("attemptOfferPayment — failure path (forfeit, ban, cascade)", () => {
  it("forfeits the deposit, bans the bidder, and cascades to the next-highest bid when the off-session charge fails", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(roundParticipants).values({ roundId, bidderId: "second-in-line", depositCents: 1_050, depositRef: "pi_second", paymentMethodRef: "pm_second" });
    await db.insert(bids).values({ roundId, bidderId: "second-in-line", amountCents: 10_500, placedAt: new Date(startsAt.getTime() + 500) });
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed");
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    const result = await attemptOfferPayment(offerId, now, provider);
    expect(result.outcome).toBe("cascaded");
    if (result.outcome !== "cascaded") throw new Error("expected cascade");

    const [participant] = await db.select().from(roundParticipants).where(eq(roundParticipants.bidderId, "a"));
    expect(participant.depositStatus).toBe("forfeited");
    expect(provider.refunds).not.toContain("pi_a");

    const [ban] = await db.select().from(bans).where(eq(bans.bidderId, "a"));
    expect(ban).toBeDefined();

    const [newOffer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, result.nextOfferId));
    expect(newOffer.bidId).not.toBe((await db.select().from(bids).where(eq(bids.bidderId, "a")))[0].id);
  });

  it("treats 'requires_action' identically to an outright decline — forfeit and ban, no special case", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("requires_action");
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    const result = await attemptOfferPayment(offerId, now, provider);
    expect(result.outcome).toBe("round-closed"); // no other bidder to cascade to

    const [ban] = await db.select().from(bans).where(eq(bans.bidderId, "a"));
    expect(ban).toBeDefined();
  });

  it("closes the round and refunds the rest when the queue is exhausted", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed");
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    const result = await attemptOfferPayment(offerId, now, provider);
    expect(result.outcome).toBe("round-closed");

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("closed");
  });

  it("closes the round instead of cascading once the round's own boundary has passed", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(roundParticipants).values({ roundId, bidderId: "second-in-line", depositCents: 1_050, depositRef: "pi_second", paymentMethodRef: "pm_second" });
    await db.insert(bids).values({ roundId, bidderId: "second-in-line", amountCents: 10_500, placedAt: new Date(startsAt.getTime() + 500) });
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed");
    const roundBoundary = new Date(startsAt.getTime() + ROUND_MS);

    const result = await attemptOfferPayment(offerId, roundBoundary, provider);
    expect(result.outcome).toBe("round-closed");

    const [second] = await db.select().from(roundParticipants).where(eq(roundParticipants.bidderId, "second-in-line"));
    expect(second.depositStatus).toBe("refunded"); // never got a turn — the round simply ran out of time
  });

  it("picks the exact next-highest bid under an amount-desc/placedAt-asc tie-break with 3+ candidates", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    for (const [bidderId, amountCents, offsetMs] of [
      ["tie-later", 10_500, 700],
      ["tie-earlier", 10_500, 500],
      ["low-bidder", 10_000, 100],
    ] as const) {
      await db.insert(roundParticipants).values({ roundId, bidderId, depositCents: 1_000, depositRef: `pi_${bidderId}`, paymentMethodRef: `pm_${bidderId}` });
      await db.insert(bids).values({ roundId, bidderId, amountCents, placedAt: new Date(startsAt.getTime() + offsetMs) });
    }
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed");
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    const result = await attemptOfferPayment(offerId, now, provider);
    expect(result.outcome).toBe("cascaded");
    if (result.outcome !== "cascaded") throw new Error("expected cascade");

    const [newOffer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, result.nextOfferId));
    const [earlierTieBid] = await db.select().from(bids).where(eq(bids.bidderId, "tie-earlier"));
    expect(newOffer.bidId).toBe(earlierTieBid.id);
  });

  it("never cascades to a bid placed after the bidding window closed", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId, snapshotAt } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(roundParticipants).values({ roundId, bidderId: "in-window", depositCents: 1_050, depositRef: "pi_in", paymentMethodRef: "pm_in" });
    const [inWindow] = await db.insert(bids).values({ roundId, bidderId: "in-window", amountCents: 10_500, placedAt: new Date(startsAt.getTime() + 500) }).returning();
    await db.insert(roundParticipants).values({ roundId, bidderId: "late", depositCents: 2_000, depositRef: "pi_late", paymentMethodRef: "pm_late" });
    await db.insert(bids).values({ roundId, bidderId: "late", amountCents: 20_000, placedAt: new Date(snapshotAt.getTime() + 1000) });
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed");

    const result = await attemptOfferPayment(offerId, new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000), provider);
    expect(result.outcome).toBe("cascaded");
    if (result.outcome !== "cascaded") throw new Error("expected cascade");

    const [newOffer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, result.nextOfferId));
    expect(newOffer.bidId).toBe(inWindow.id);
  });

  it("a second concurrent call for the same offer is a safe no-op — only one ban row and one cascade result", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(roundParticipants).values({ roundId, bidderId: "second-in-line", depositCents: 1_050, depositRef: "pi_second", paymentMethodRef: "pm_second" });
    await db.insert(bids).values({ roundId, bidderId: "second-in-line", amountCents: 10_500, placedAt: new Date(startsAt.getTime() + 500) });
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed");
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    const [first, second] = await Promise.all([
      attemptOfferPayment(offerId, now, provider),
      attemptOfferPayment(offerId, now, provider),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["already-processed", "cascaded"]);

    const allBans = await db.select().from(bans).where(eq(bans.bidderId, "a"));
    expect(allBans).toHaveLength(1);
  });
});

describe("cross-cutting: cascade then payment must not un-forfeit the earlier non-payer", () => {
  it("does not refund a deposit already forfeited by an earlier cascade step when the eventual winner pays", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(roundParticipants).values({ roundId, bidderId: "second-in-line", depositCents: 1_050, depositRef: "pi_second", paymentMethodRef: "pm_second" });
    await db.insert(bids).values({ roundId, bidderId: "second-in-line", amountCents: 10_500, placedAt: new Date(startsAt.getTime() + 500) });
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed");
    const now = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);

    const cascadeResult = await attemptOfferPayment(offerId, now, provider);
    expect(cascadeResult.outcome).toBe("cascaded");
    if (cascadeResult.outcome !== "cascaded") throw new Error("expected cascade");

    const payResult = await attemptOfferPayment(cascadeResult.nextOfferId, new Date(now.getTime() + 1000), provider);
    expect(payResult.outcome).toBe("paid");

    expect(provider.refunds).not.toContain("pi_a");
    const [forfeitedParticipant] = await db.select().from(roundParticipants).where(eq(roundParticipants.bidderId, "a"));
    expect(forfeitedParticipant.depositStatus).toBe("forfeited");
  });
});

describe("settleRound", () => {
  it("resolves straight to 'paid' when the first offer succeeds", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { offerId } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();

    const result = await settleRound(offerId, new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000), provider);
    expect(result.outcome).toBe("paid");
  });

  it("follows a cascade through to a later payer without the caller doing anything else", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offerId } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(roundParticipants).values({ roundId, bidderId: "second-in-line", depositCents: 1_050, depositRef: "pi_second", paymentMethodRef: "pm_second" });
    await db.insert(bids).values({ roundId, bidderId: "second-in-line", amountCents: 10_500, placedAt: new Date(startsAt.getTime() + 500) });
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed"); // only the FIRST attempt (bidder "a") fails

    const result = await settleRound(offerId, new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000), provider);
    expect(result.outcome).toBe("paid");

    const [second] = await db.select().from(roundParticipants).where(eq(roundParticipants.bidderId, "second-in-line"));
    expect(second.depositStatus).toBe("applied");
  });

  it("resolves to 'round-closed' when every candidate fails", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { offerId } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    provider.failNextRemainderCharge("failed");

    const result = await settleRound(offerId, new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000), provider);
    expect(result.outcome).toBe("round-closed");
  });
});
```

- [ ] **Step 2: Update `roundResolution.snapshot.test.ts` first**

Replace `apps/engine/tests/engine/roundResolution.snapshot.test.ts` with:

```ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans, paymentOffers, roundParticipants } from "../../src/db/schema";
import { resolveBiddingPhaseSnapshot } from "../../src/engine/roundResolution";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";
import { eq } from "drizzle-orm";
import { PAYMENT_ATTEMPT_MS, ROUND_MS, BIDDING_PHASE_MS } from "../../src/domain/config";

afterEach(async () => {
  await db.delete(paymentOffers);
  await db.delete(roundParticipants);
  await db.delete(bids);
  await db.delete(bans);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

async function seedRound(startsAt: Date) {
  const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: startsAt }).returning();
  const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt, phase: "bidding" }).returning();
  return { reignId: reign.id, roundId: round.id };
}

async function join(roundId: string, bidderId: string, depositRef: string) {
  await db.insert(roundParticipants).values({ roundId, bidderId, depositCents: 1_100, depositRef, paymentMethodRef: `pm_${bidderId}` });
}

describe("resolveBiddingPhaseSnapshot", () => {
  it("closes the round with no change when the queue is empty", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);

    const result = await resolveBiddingPhaseSnapshot(roundId, snapshotAt, new FakePaymentProvider());
    expect(result.outcome).toBe("empty-closed");

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("closed");
  });

  it("creates a payment offer for the snapshot leader when the queue is non-empty", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    await join(roundId, "a", "pi_a");
    const [bid] = await db
      .insert(bids)
      .values({ roundId, bidderId: "a", amountCents: 11_000, placedAt: new Date(startsAt.getTime() + 1000) })
      .returning();
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);

    const result = await resolveBiddingPhaseSnapshot(roundId, snapshotAt, new FakePaymentProvider());
    expect(result.outcome).toBe("offer-created");
    if (result.outcome !== "offer-created") throw new Error("expected offer");

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("payment");

    const [offer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, result.offerId));
    expect(offer.bidId).toBe(bid.id);
    expect(offer.status).toBe("pending");
    expect(offer.expiresAt.getTime()).toBe(Math.min(snapshotAt.getTime() + PAYMENT_ATTEMPT_MS, startsAt.getTime() + ROUND_MS));
  });

  it("a second concurrent call for the same round is a safe no-op — never creates two payment offers", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    await join(roundId, "a", "pi_a");
    await db.insert(bids).values({ roundId, bidderId: "a", amountCents: 11_000, placedAt: new Date(startsAt.getTime() + 1000) });
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);

    const [first, second] = await Promise.all([
      resolveBiddingPhaseSnapshot(roundId, snapshotAt, new FakePaymentProvider()),
      resolveBiddingPhaseSnapshot(roundId, snapshotAt, new FakePaymentProvider()),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["already-resolving", "offer-created"]);

    const offers = await db.select().from(paymentOffers).where(eq(paymentOffers.roundId, roundId));
    expect(offers).toHaveLength(1);
  });

  it("refunds and closes instead of offering when the payment window has already elapsed", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    await join(roundId, "leader", "pi_leader");
    await join(roundId, "runner-up", "pi_runner");
    await db.insert(bids).values([
      { roundId, bidderId: "leader", amountCents: 11_000, placedAt: new Date(startsAt.getTime() + 1000) },
      { roundId, bidderId: "runner-up", amountCents: 10_500, placedAt: new Date(startsAt.getTime() + 500) },
    ]);
    const lateSnapshot = new Date(startsAt.getTime() + ROUND_MS + PAYMENT_ATTEMPT_MS);
    const provider = new FakePaymentProvider();

    const result = await resolveBiddingPhaseSnapshot(roundId, lateSnapshot, provider);
    expect(result.outcome).toBe("empty-closed");

    const offers = await db.select().from(paymentOffers).where(eq(paymentOffers.roundId, roundId));
    expect(offers).toHaveLength(0);

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("closed");

    const participants = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    expect(participants.every((p) => p.depositStatus === "refunded")).toBe(true);
    expect(provider.refunds.sort()).toEqual(["pi_leader", "pi_runner"]);

    const allBans = await db.select().from(bans);
    expect(allBans).toHaveLength(0);
  });

  it("ignores a bid placed after the bidding window closed when picking the snapshot leader", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);
    await join(roundId, "honest", "pi_honest");
    const [inWindow] = await db
      .insert(bids)
      .values({ roundId, bidderId: "honest", amountCents: 11_000, placedAt: new Date(startsAt.getTime() + 1000) })
      .returning();
    await join(roundId, "sniper", "pi_sniper");
    await db.insert(bids).values({ roundId, bidderId: "sniper", amountCents: 99_000, placedAt: new Date(snapshotAt.getTime() + 1000) });

    const result = await resolveBiddingPhaseSnapshot(roundId, snapshotAt, new FakePaymentProvider());
    expect(result.outcome).toBe("offer-created");
    if (result.outcome !== "offer-created") throw new Error("expected offer");

    const [offer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, result.offerId));
    expect(offer.bidId).toBe(inWindow.id);
  });
});
```

- [ ] **Step 3: Run to verify both test files fail**

Run: `npm test --workspace=apps/engine -- roundResolution.payment.test.ts roundResolution.snapshot.test.ts`
Expected: FAIL (`attemptOfferPayment`/`settleRound` don't exist; `resolveBiddingPhaseSnapshot` doesn't return `offerId`)

- [ ] **Step 4: Implement**

Replace `apps/engine/src/engine/roundResolution.ts` with:

```ts
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { rounds, paymentOffers, bids, bans, roundParticipants } from "../db/schema";
import { getQueueLeader } from "../db/repository";
import { installChampion } from "./installChampion";
import { PAYMENT_ATTEMPT_MS, ROUND_MS, BAN_DURATION_MS, BIDDING_PHASE_MS } from "../domain/config";
import type { PaymentProvider } from "../payments/PaymentProvider";

export async function resolveBiddingPhaseSnapshot(
  roundId: string,
  snapshotAt: Date,
  provider: PaymentProvider,
  executedAt: Date = snapshotAt,
): Promise<{ outcome: "empty-closed" } | { outcome: "already-resolving" } | { outcome: "offer-created"; offerId: string }> {
  // Claim-before-snapshot: symmetric to attemptOfferPayment's claim-before-charge
  // guard below. Without this, two overlapping scheduler ticks (or two worker
  // instances) both seeing phase = "bidding" would both proceed, each creating
  // its own paymentOffers row for the same round.
  const claimed = await db
    .update(rounds)
    .set({ phase: "resolving" })
    .where(and(eq(rounds.id, roundId), eq(rounds.phase, "bidding")))
    .returning();

  if (claimed.length === 0) {
    // A concurrent caller already claimed this round (its own UPDATE moved
    // the phase off "bidding" first) — distinct from "empty-closed" (this
    // caller genuinely closed an empty round itself). Collapsing this into
    // "empty-closed" would make the losing side of the race tell the
    // scheduler to start the next round while the winning side is still
    // resolving this one — a real duplicate-round hazard, not just an
    // inaccurate return value.
    return { outcome: "already-resolving" };
  }
  const round = claimed[0];

  const leader = await getQueueLeader(roundId, snapshotAt);

  if (!leader) {
    // A participant can join (pay the deposit) and never place a bid, or
    // every bid placed can land after snapshotAt and be filtered out by
    // getQueueLeader's asOf — either way, an empty queue does not mean no
    // deposits are held. Unlike before this plan's rework (when deposits
    // lived on bids and "no leader" really did mean "nothing to refund"),
    // deposits now live on roundParticipants independently of bidding, so
    // this path must sweep them too.
    await closeRoundAndRefundHeld(roundId, provider);
    return { outcome: "empty-closed" };
  }

  const roundBoundary = new Date(round.startsAt.getTime() + ROUND_MS);
  const attemptExpiry = new Date(snapshotAt.getTime() + PAYMENT_ATTEMPT_MS);
  const expiresAt = attemptExpiry.getTime() < roundBoundary.getTime() ? attemptExpiry : roundBoundary;

  if (expiresAt.getTime() <= executedAt.getTime()) {
    // The scheduler is running late enough that the payment offer would be born
    // already expired — an infrastructure failure, not a bidder failure. Hand
    // nobody an offer, give every held deposit in the round back, and close
    // the round in the same terminal state as an empty one.
    await closeRoundAndRefundHeld(roundId, provider);
    return { outcome: "empty-closed" };
  }

  const [offer] = await db
    .insert(paymentOffers)
    .values({
      roundId,
      bidId: leader.id,
      offeredAt: snapshotAt,
      expiresAt,
      status: "pending",
    })
    .returning();
  await db.update(rounds).set({ phase: "payment" }).where(eq(rounds.id, roundId));

  return { outcome: "offer-created", offerId: offer.id };
}

// Attempts the off-session remainder charge for one payment offer and settles
// it fully, one way or the other:
//   - "paid": the charge succeeded — champion installed, other held deposits
//     refunded.
//   - "cascaded": the charge failed (declined or requires_action — treated
//     identically) — this bidder is forfeited and banned, and the next-highest
//     still-held bid gets its own new pending offer (nextOfferId).
//   - "round-closed": the charge failed and there was nobody left to cascade
//     to, or the round's own boundary had already passed.
//   - "already-processed": a concurrent call already claimed this offer.
//
// Replaces the old confirmPayment/resolveExpiredOffer split — see this
// plan's Task 7 rationale for why that split no longer applies now that the
// remainder charge is automatic and off-session instead of something a
// human confirms interactively.
export async function attemptOfferPayment(
  offerId: string,
  now: Date,
  provider: PaymentProvider,
  onInstalled?: (occupantId: string) => void,
): Promise<
  | { outcome: "paid" }
  | { outcome: "cascaded"; nextOfferId: string }
  | { outcome: "round-closed" }
  | { outcome: "already-processed" }
> {
  // Claim-before-charge: this single conditional UPDATE is what makes concurrent
  // duplicate calls safe — a second concurrent UPDATE targeting the same row
  // blocks until the first commits, then re-evaluates `status = 'pending'`
  // against the now-"processing" row and affects 0 rows.
  const claimed = await db
    .update(paymentOffers)
    .set({ status: "processing" })
    .where(and(eq(paymentOffers.id, offerId), eq(paymentOffers.status, "pending")))
    .returning();

  if (claimed.length === 0) {
    return { outcome: "already-processed" };
  }
  const offer = claimed[0];

  const [bid] = await db.select().from(bids).where(eq(bids.id, offer.bidId)).limit(1);
  if (!bid) throw new Error("Bid not found for offer.");

  const [round] = await db.select().from(rounds).where(eq(rounds.id, offer.roundId)).limit(1);
  if (!round) throw new Error("Round not found.");

  const [participant] = await db
    .select()
    .from(roundParticipants)
    .where(and(eq(roundParticipants.roundId, offer.roundId), eq(roundParticipants.bidderId, bid.bidderId)))
    .limit(1);
  if (!participant) throw new Error("Round participant not found for offer's bidder.");

  const remainderCents = bid.amountCents - participant.depositCents;
  const chargeResult = await provider.chargeRemainderOffSession(participant.paymentMethodRef, remainderCents);

  if (chargeResult === "succeeded") {
    await db.update(paymentOffers).set({ status: "paid" }).where(eq(paymentOffers.id, offerId));
    await db.update(rounds).set({ phase: "closed" }).where(eq(rounds.id, offer.roundId));
    // "applied", not "refunded": the winner's deposit is credited toward the
    // final price (the charge is amount - deposit), it is never given back.
    await db.update(roundParticipants).set({ depositStatus: "applied" }).where(eq(roundParticipants.id, participant.id));

    const otherParticipants = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, offer.roundId));
    for (const other of otherParticipants) {
      // Only refund participants still "held" — one already forfeited in an
      // earlier cascade step must stay forfeited; refunding it here would
      // un-do the non-payment penalty for a banned bidder.
      if (other.id === participant.id || other.depositStatus !== "held") continue;
      await provider.refund(other.depositRef);
      await db.update(roundParticipants).set({ depositStatus: "refunded" }).where(eq(roundParticipants.id, other.id));
    }

    await installChampion(bid.bidderId, bid.amountCents, now, onInstalled);
    return { outcome: "paid" };
  }

  // chargeResult is "requires_action" or "failed" — both treated as
  // non-payment. Per the approved design, a bank requiring extra
  // authentication is not special-cased into a grace period; it bans exactly
  // like an outright decline, since building a retry/notification path is
  // explicitly out of scope for this feature.
  //
  // The offer itself is stamped "expired" (not left "processing") so it's
  // distinguishable later from an offer that's still genuinely mid-flight —
  // "processing" means "an attempt is in progress right now", not "an
  // attempt was made and declined".
  await db.update(paymentOffers).set({ status: "expired" }).where(eq(paymentOffers.id, offerId));
  await db.update(roundParticipants).set({ depositStatus: "forfeited" }).where(eq(roundParticipants.id, participant.id));
  await db.insert(bans).values({ bidderId: bid.bidderId, bannedUntil: new Date(now.getTime() + BAN_DURATION_MS) });

  const roundBoundary = new Date(round.startsAt.getTime() + ROUND_MS);
  if (now.getTime() >= roundBoundary.getTime()) {
    await closeRoundAndRefundHeld(round.id, provider, participant.id);
    return { outcome: "round-closed" };
  }

  const biddingClosedAt = new Date(round.startsAt.getTime() + BIDDING_PHASE_MS);
  const remainingBids = await db.select().from(bids).where(eq(bids.roundId, offer.roundId));
  const heldParticipants = await db
    .select()
    .from(roundParticipants)
    .where(and(eq(roundParticipants.roundId, offer.roundId), eq(roundParticipants.depositStatus, "held")));
  const heldBidderIds = new Set(heldParticipants.map((p) => p.bidderId));

  const nextCandidates = remainingBids.filter(
    (b) => b.id !== offer.bidId && heldBidderIds.has(b.bidderId) && b.placedAt.getTime() <= biddingClosedAt.getTime(),
  );
  nextCandidates.sort((a, b) => b.amountCents - a.amountCents || a.placedAt.getTime() - b.placedAt.getTime());
  const next = nextCandidates[0];

  if (!next) {
    await closeRoundAndRefundHeld(round.id, provider, participant.id);
    return { outcome: "round-closed" };
  }

  const attemptExpiry = new Date(now.getTime() + PAYMENT_ATTEMPT_MS);
  const nextExpiresAt = attemptExpiry.getTime() < roundBoundary.getTime() ? attemptExpiry : roundBoundary;

  const [nextOffer] = await db
    .insert(paymentOffers)
    .values({
      roundId: round.id,
      bidId: next.id,
      offeredAt: now,
      // expiresAt is retained for the scheduler's crash-recovery poll (Task 8)
      // but is not expected to be reached in normal operation — settleRound
      // attempts this new offer immediately, in the same call chain.
      expiresAt: nextExpiresAt,
      status: "pending",
    })
    .returning();

  return { outcome: "cascaded", nextOfferId: nextOffer.id };
}

// Attempts offerId and, on a cascade, immediately attempts the next offer too
// — repeating until the round is settled. This is what a caller should use
// in practice; attemptOfferPayment on its own only performs a single step.
export async function settleRound(
  offerId: string,
  now: Date,
  provider: PaymentProvider,
  onInstalled?: (occupantId: string) => void,
): Promise<{ outcome: "paid" } | { outcome: "round-closed" }> {
  let currentOfferId = offerId;
  for (;;) {
    const result = await attemptOfferPayment(currentOfferId, now, provider, onInstalled);
    if (result.outcome === "paid" || result.outcome === "round-closed") {
      return result;
    }
    if (result.outcome === "already-processed") {
      // A concurrent settleRound (or the scheduler's crash-recovery poll)
      // already claimed this offer — nothing more for this call to do.
      return { outcome: "round-closed" };
    }
    currentOfferId = result.nextOfferId;
  }
}

// Closes the round and gives back every deposit still "held" on it. A
// participant that already forfeited (a non-payer earlier in the cascade) or
// was already refunded is left alone — depositStatus !== "held" already
// guards that; excludeParticipantId is a belt-and-suspenders extra for the
// participant whose forfeit just happened moments earlier in the same call.
async function closeRoundAndRefundHeld(
  roundId: string,
  provider: PaymentProvider,
  excludeParticipantId?: string,
): Promise<void> {
  await db.update(rounds).set({ phase: "closed" }).where(eq(rounds.id, roundId));

  const remaining = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
  for (const p of remaining) {
    if (p.id === excludeParticipantId || p.depositStatus !== "held") continue;
    await provider.refund(p.depositRef);
    await db.update(roundParticipants).set({ depositStatus: "refunded" }).where(eq(roundParticipants.id, p.id));
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npm test --workspace=apps/engine -- roundResolution.payment.test.ts roundResolution.snapshot.test.ts`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add apps/engine/src/engine/roundResolution.ts apps/engine/tests/engine/roundResolution.payment.test.ts apps/engine/tests/engine/roundResolution.snapshot.test.ts
git commit -m "feat(engine): automatic off-session settlement — merge confirmPayment/resolveExpiredOffer into attemptOfferPayment+settleRound"
```

---

### Task 8: `scheduler.ts` — settle immediately, poll only as a crash-recovery net

**Files:**
- Modify: `apps/engine/src/engine/scheduler.ts`
- Test: `apps/engine/tests/engine/scheduler.test.ts`

**Interfaces:**
- Consumes: `resolveBiddingPhaseSnapshot`, `settleRound` (Task 7).
- Produces: `tick(now: Date, provider: PaymentProvider): Promise<void>` — same signature as
  before.

- [ ] **Step 1: Update `scheduler.test.ts` first**

Replace `apps/engine/tests/engine/scheduler.test.ts` with:

```ts
// tests/engine/scheduler.test.ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans, paymentOffers, roundParticipants } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { placeBid } from "../../src/engine/placeBid";
import { tick } from "../../src/engine/scheduler";
import { getCurrentReign, getLatestRound } from "../../src/db/repository";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";
import { BIDDING_PHASE_MS, ROUND_MS } from "../../src/domain/config";
import { eq } from "drizzle-orm";

afterEach(async () => {
  await db.delete(paymentOffers);
  await db.delete(roundParticipants);
  await db.delete(bids);
  await db.delete(bans);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

async function currentRoundId(reignId: string): Promise<string> {
  const round = await getLatestRound(reignId);
  return round!.id;
}

async function join(roundId: string, bidderId: string) {
  await db.insert(roundParticipants).values({ roundId, bidderId, depositCents: 1_100, depositRef: `pi_${bidderId}`, paymentMethodRef: `pm_${bidderId}` });
}

describe("tick", () => {
  it("rolls an empty round straight into the next day's round", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const provider = new FakePaymentProvider();

    await tick(new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000), provider);

    const round = await getLatestRound(reign.id);
    expect(round?.startsAt).toEqual(new Date(startsAt.getTime() + ROUND_MS));
    expect(round?.phase).toBe("bidding");
  });

  it("settles a winning bid immediately, in the same tick that snapshots the round", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const provider = new FakePaymentProvider();
    await join(await currentRoundId(reign.id), "winner");

    const bidResult = await placeBid({ bidderId: "winner", amountCents: 11_000, now: new Date(startsAt.getTime() + 1000) });
    expect(bidResult.ok).toBe(true);

    await tick(new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000), provider);

    expect(provider.remainderCharges).toHaveLength(1);
    const current = await getCurrentReign();
    expect(current?.occupantId).toBe("winner");

    const nextRound = await getLatestRound(current!.id);
    expect(nextRound?.startsAt).toEqual(new Date(startsAt.getTime() + ROUND_MS));
    expect(nextRound?.phase).toBe("bidding");
  });

  it("survives an empty day then a failed off-session charge, chaining into a new round each time", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    await createInitialReign("champ", startsAt);
    const provider = new FakePaymentProvider();

    // Day 1: nobody bids.
    await tick(new Date(startsAt.getTime() + ROUND_MS - 1000), provider);

    // Day 2: a challenger bids, but their off-session charge fails.
    const day2Reign = await getCurrentReign();
    const day2Start = new Date(startsAt.getTime() + ROUND_MS);
    await join(await currentRoundId(day2Reign!.id), "winner");
    const bidResult = await placeBid({ bidderId: "winner", amountCents: 11_000, now: new Date(day2Start.getTime() + 1000) });
    expect(bidResult.ok).toBe(true);

    provider.failNextRemainderCharge("failed");
    await tick(new Date(day2Start.getTime() + BIDDING_PHASE_MS + 1000), provider);

    const afterSettlement = await getCurrentReign();
    expect(afterSettlement?.occupantId).toBe("champ"); // still champ, queue was exhausted after the one bidder

    const finalRound = await getLatestRound(afterSettlement!.id);
    expect(finalRound?.startsAt).toEqual(new Date(day2Start.getTime() + ROUND_MS));
    expect(finalRound?.phase).toBe("bidding");
  });

  it("never forfeits or bans the leader when the tick itself runs late", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const provider = new FakePaymentProvider();
    await join(await currentRoundId(reign.id), "unlucky");

    const bidResult = await placeBid({ bidderId: "unlucky", amountCents: 11_000, now: new Date(startsAt.getTime() + 1000) });
    expect(bidResult.ok).toBe(true);

    // 3h after the window closed — the 1h payment window (ending at T0+13h)
    // is long gone before the scheduler ever runs.
    await tick(new Date(startsAt.getTime() + BIDDING_PHASE_MS + 3 * 60 * 60 * 1000), provider);

    expect(await db.select().from(paymentOffers)).toHaveLength(0);
    expect(await db.select().from(bans)).toHaveLength(0);

    const [participant] = await db.select().from(roundParticipants).where(eq(roundParticipants.bidderId, "unlucky"));
    expect(participant.depositStatus).toBe("refunded");
    expect(provider.refunds).toEqual([participant.depositRef]);

    const current = await getCurrentReign();
    expect(current?.occupantId).toBe("champ");
    const nextRound = await getLatestRound(reign.id);
    expect(nextRound?.startsAt).toEqual(new Date(startsAt.getTime() + ROUND_MS));
    expect(nextRound?.phase).toBe("bidding");
  });

  it("crash-recovery: an offer stuck 'pending' past its expiry (as if a prior tick died mid-settlement) still gets settled", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const provider = new FakePaymentProvider();
    await join(await currentRoundId(reign.id), "winner");
    await placeBid({ bidderId: "winner", amountCents: 11_000, now: new Date(startsAt.getTime() + 1000) });

    // Simulate a prior tick that created the snapshot's offer (via
    // resolveBiddingPhaseSnapshot) but crashed before settleRound ever ran —
    // insert the pending offer directly rather than going through tick(), so
    // this test exercises tick()'s poll-based safety net, not its normal path.
    const roundId = await currentRoundId(reign.id);
    const [bid] = await db.select().from(bids).where(eq(bids.roundId, roundId));
    const offeredAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);
    await db.update(rounds).set({ phase: "payment" }).where(eq(rounds.id, roundId));
    await db.insert(paymentOffers).values({
      roundId,
      bidId: bid.id,
      offeredAt,
      expiresAt: new Date(offeredAt.getTime() + 1000),
      status: "pending",
    });

    await tick(new Date(offeredAt.getTime() + 2000), provider);

    expect(provider.remainderCharges).toHaveLength(1);
    const current = await getCurrentReign();
    expect(current?.occupantId).toBe("winner");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace=apps/engine -- scheduler.test.ts`
Expected: FAIL (`scheduler.ts` still imports `resolveExpiredOffer`, which no longer exists)

- [ ] **Step 3: Implement**

Replace `apps/engine/src/engine/scheduler.ts` with:

```ts
import { and, eq, lte, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { reigns, rounds, paymentOffers } from "../db/schema";
import { resolveBiddingPhaseSnapshot, settleRound } from "./roundResolution";
import { ROUND_MS, BIDDING_PHASE_MS } from "../domain/config";
import type { PaymentProvider } from "../payments/PaymentProvider";

export async function tick(now: Date, provider: PaymentProvider): Promise<void> {
  const dueBiddingRounds = await db
    .select()
    .from(rounds)
    .where(eq(rounds.phase, "bidding"));

  for (const round of dueBiddingRounds) {
    const snapshotAt = new Date(round.startsAt.getTime() + BIDDING_PHASE_MS);
    if (now.getTime() < snapshotAt.getTime()) continue;

    try {
      const result = await resolveBiddingPhaseSnapshot(round.id, snapshotAt, provider, now);
      if (result.outcome === "empty-closed") {
        await startNextRound(round.reignId, round.startsAt);
      } else if (result.outcome === "offer-created") {
        // The remainder charge is off-session and automatic — attempt it
        // (and follow any cascade) immediately, in this same tick, rather
        // than waiting for a bidder who was never going to be interactively
        // involved in the first place.
        const settled = await settleRound(result.offerId, now, provider);
        if (settled.outcome === "round-closed") {
          await startNextRound(round.reignId, round.startsAt);
        }
      }
      // result.outcome === "already-resolving": a concurrent caller (another
      // tick, or another worker instance) already claimed this round in the
      // same instant — that caller is responsible for driving it to
      // settlement, this one does nothing further.
    } catch (err) {
      // One round's failure (a transient DB error, a provider hiccup further
      // down the chain) must not abort the whole tick — the failing row gets
      // re-selected on every subsequent tick, so letting it propagate would
      // turn a transient blip into a permanent poison pill blocking every
      // other due round.
      console.error(`tick: failed to resolve bidding-phase snapshot for round ${round.id}`, err);
    }
  }

  // Crash-recovery safety net: in normal operation, settleRound above resolves
  // every offer the instant it's created, so nothing should still be "pending"
  // once its expiresAt has passed. This catches the rare case where a prior
  // process died between resolveBiddingPhaseSnapshot creating an offer and
  // settleRound ever being called on it (settleRound's own claim-before-charge
  // guard is what makes retrying it here safe).
  //
  // Known residual gap (not solved by this poll, and out of scope for this
  // plan — matches other narrow crash-window gaps already accepted elsewhere
  // in this codebase): if the process instead dies AFTER attemptOfferPayment
  // claims an offer to "processing" but BEFORE it finishes, the offer is
  // invisible to this poll (it only selects `status = "pending"`) and the
  // round is stuck in phase "payment" indefinitely — nothing currently
  // reclaims a stale "processing" offer, because doing so safely requires
  // reconciling against Stripe's own record of whether the charge actually
  // went through before retrying it (retrying blind risks a double charge).
  // A future hardening pass should add that reconciliation; this plan does
  // not attempt it.
  const duePendingOffers = await db
    .select()
    .from(paymentOffers)
    .where(and(eq(paymentOffers.status, "pending"), lte(paymentOffers.expiresAt, now)));

  for (const offer of duePendingOffers) {
    try {
      const [round] = await db.select().from(rounds).where(eq(rounds.id, offer.roundId)).limit(1);
      const result = await settleRound(offer.id, now, provider);
      if (result.outcome === "round-closed") {
        await startNextRound(round.reignId, round.startsAt);
      }
    } catch (err) {
      console.error(`tick: failed to settle overdue payment offer ${offer.id}`, err);
    }
  }
}

async function startNextRound(reignId: string, previousRoundStartsAt: Date): Promise<void> {
  const [reign] = await db.select().from(reigns).where(and(eq(reigns.id, reignId), isNull(reigns.endedAt))).limit(1);
  if (!reign) return; // reign already ended (a payment resolved it) — no next round to start
  await db.insert(rounds).values({
    reignId,
    startsAt: new Date(previousRoundStartsAt.getTime() + ROUND_MS),
    phase: "bidding",
  });
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=apps/engine -- scheduler.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full engine test suite to confirm nothing else broke**

Run: `npm test --workspace=apps/engine`
Expected: PASS (every test file, including `bootstrap.test.ts`, `installChampion.test.ts`,
`bidValidation.test.ts`, `publicScene.test.ts`, `smoke.test.ts`, which this plan does not touch)

- [ ] **Step 6: Commit**

```bash
git add apps/engine/src/engine/scheduler.ts apps/engine/tests/engine/scheduler.test.ts
git commit -m "feat(engine): scheduler settles offers immediately, polls only for crash recovery"
```

---

### Task 9: `getCurrentRoundInfo` — the live read the frontend needs to render bidding state

**Files:**
- Modify: `apps/engine/src/queries/publicScene.ts`
- Test: `apps/engine/tests/queries/publicScene.test.ts`

**Interfaces:**
- Consumes: `getCurrentReign`, `getLatestRound`, `getQueueLeader` (`../db/repository`),
  `calculateDeposit` (`../domain/deposit`), `BIDDING_PHASE_MS` (`../domain/config`).
- Produces:
  `getCurrentRoundInfo(now: Date): Promise<{ roundId: string; phase: "bidding"|"resolving"|"payment"|"closed"; currentLeaderCents: number; depositCents: number; biddingClosesAt: Date } | null>`

This is the one piece of "live bidding state" the browser needs that the existing, build-time-only
`getScene`/`getLeaderboard` don't cover — the current round id, price, and deposit amount, all of
which change continuously and can't be baked into a static build.

- [ ] **Step 1: Replace the test file**

Replace `apps/engine/tests/queries/publicScene.test.ts` in full with (this adds the new
`getCurrentRoundInfo` describe block, extends `afterEach` to also clean up `rounds` — needed
because `createInitialReign` now used in the new tests inserts a round too, which the file's
existing `afterEach` didn't previously need to touch — and leaves every existing `getScene`/
`getLeaderboard` test byte-for-byte unchanged):

```ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds } from "../../src/db/schema";
import { getScene, getLeaderboard, getCurrentRoundInfo } from "../../src/queries/publicScene";
import { createInitialReign } from "../../src/engine/bootstrap";
import { getLatestRound } from "../../src/db/repository";
import { BIDDING_PHASE_MS } from "../../src/domain/config";

afterEach(async () => {
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

describe("getScene", () => {
  it("returns null champion and empty retinue with no reigns", async () => {
    const scene = await getScene(new Date());
    expect(scene.champion).toBeNull();
    expect(scene.retinue).toEqual([]);
  });

  it("returns the current champion and the last 8 ended reigns, most recent first", async () => {
    const base = new Date(2026, 0, 1);
    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 9; i++) {
      await db.insert(reigns).values({
        occupantId: `past-${i}`,
        priceCents: 10_000 + i,
        startedAt: new Date(base.getTime() + i * day),
        endedAt: new Date(base.getTime() + (i + 1) * day),
      });
    }
    await db.insert(reigns).values({ occupantId: "current", priceCents: 99_000, startedAt: new Date(base.getTime() + 9 * day) });

    const scene = await getScene(new Date(base.getTime() + 10 * day));
    expect(scene.champion?.occupantId).toBe("current");
    expect(scene.retinue).toHaveLength(8);
    expect(scene.retinue[0].occupantId).toBe("past-8"); // most recent ended reign first
    expect(scene.retinue[7].occupantId).toBe("past-1"); // 9th-oldest (past-0) dropped off
  });
});

describe("getLeaderboard", () => {
  it("aggregates rounds count, total spent, and total duration per occupant", async () => {
    const base = new Date(2026, 0, 1);
    const day = 24 * 60 * 60 * 1000;
    await db.insert(reigns).values([
      { occupantId: "alice", priceCents: 10_000, startedAt: base, endedAt: new Date(base.getTime() + day) },
      { occupantId: "alice", priceCents: 15_000, startedAt: new Date(base.getTime() + day), endedAt: new Date(base.getTime() + 3 * day) },
      { occupantId: "bob", priceCents: 20_000, startedAt: new Date(base.getTime() + 3 * day), endedAt: new Date(base.getTime() + 4 * day) },
    ]);

    const board = await getLeaderboard();
    const alice = board.find((r) => r.occupantId === "alice");
    expect(alice?.rounds).toBe(2);
    expect(alice?.totalSpentCents).toBe(25_000);
    expect(alice?.totalDurationMs).toBe(3 * day);

    expect(board[0].occupantId).toBe("alice"); // longer cumulative time than bob, ranked first
  });
});

describe("getCurrentRoundInfo", () => {
  it("returns null when no reign exists", async () => {
    expect(await getCurrentRoundInfo(new Date())).toBeNull();
  });

  it("returns the round id, phase, leader price, and fixed deposit for the current round", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const round = await getLatestRound(reign.id);

    const info = await getCurrentRoundInfo(new Date(startsAt.getTime() + 1000));
    expect(info).not.toBeNull();
    expect(info?.roundId).toBe(round!.id);
    expect(info?.phase).toBe("bidding");
    expect(info?.currentLeaderCents).toBe(reign.priceCents); // no bids yet — leader is the champion's price
    expect(info?.depositCents).toBe(Math.round(reign.priceCents * 0.10));
    expect(info?.biddingClosesAt).toEqual(new Date(startsAt.getTime() + BIDDING_PHASE_MS));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace=apps/engine -- publicScene.test.ts`
Expected: FAIL (`getCurrentRoundInfo` does not exist)

- [ ] **Step 3: Implement**

Add to `apps/engine/src/queries/publicScene.ts` (append; keep `getScene`/`getLeaderboard` as
they are):

```ts
import { getCurrentReign, getLatestRound, getQueueLeader } from "../db/repository";
import { calculateDeposit } from "../domain/deposit";
import { BIDDING_PHASE_MS } from "../domain/config";

export async function getCurrentRoundInfo(_now: Date): Promise<{
  roundId: string;
  phase: "bidding" | "resolving" | "payment" | "closed";
  currentLeaderCents: number;
  depositCents: number;
  biddingClosesAt: Date;
} | null> {
  const reign = await getCurrentReign();
  if (!reign) return null;

  const round = await getLatestRound(reign.id);
  if (!round) return null;

  const topBid = await getQueueLeader(round.id);

  return {
    roundId: round.id,
    phase: round.phase,
    currentLeaderCents: topBid ? topBid.amountCents : reign.priceCents,
    depositCents: calculateDeposit(reign.priceCents),
    biddingClosesAt: new Date(round.startsAt.getTime() + BIDDING_PHASE_MS),
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=apps/engine -- publicScene.test.ts`
Expected: PASS (all tests, including the pre-existing `getScene`/`getLeaderboard` ones)

- [ ] **Step 5: Commit**

```bash
git add apps/engine/src/queries/publicScene.ts apps/engine/tests/queries/publicScene.test.ts
git commit -m "feat(engine): add getCurrentRoundInfo — the live round/price/deposit read"
```

---

### Task 10: `StripePaymentProvider` (`apps/api`)

**Files:**
- Create: `apps/api/src/payments/StripePaymentProvider.ts`
- Test: `apps/api/tests/payments/StripePaymentProvider.test.ts`
- Modify: `apps/api/package.json` (add `stripe` dependency)
- Modify: `apps/api/.env.example`

**Interfaces:**
- Consumes: `PaymentProvider` (`engine/payments/PaymentProvider`), the `stripe` npm SDK.
- Produces: `class StripePaymentProvider implements PaymentProvider`, constructed as
  `new StripePaymentProvider(stripe: Stripe, currency: string)`.

- [ ] **Step 1: Add the `stripe` dependency**

Add to `apps/api/package.json`'s `"dependencies"`:

```json
    "stripe": "^17.4.0",
```

Run: `npm install --workspace=apps/api`

- [ ] **Step 2: Add Stripe env vars to `.env.example`**

Replace `apps/api/.env.example` with:

```
DATABASE_URL=postgres://auction:auction@localhost:5433/auction_engine_test
PORT=3001
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

- [ ] **Step 3: Write the failing test**

Create `apps/api/tests/payments/StripePaymentProvider.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { StripePaymentProvider } from "../../src/payments/StripePaymentProvider";

function fakeStripe(overrides: Partial<{ create: any; createRefund: any }> = {}) {
  return {
    paymentIntents: { create: overrides.create ?? vi.fn() },
    refunds: { create: overrides.createRefund ?? vi.fn() },
  } as any;
}

describe("StripePaymentProvider", () => {
  it("returns 'succeeded' when Stripe confirms the off-session PaymentIntent as succeeded", async () => {
    const create = vi.fn(async () => ({ status: "succeeded" }));
    const provider = new StripePaymentProvider(fakeStripe({ create }), "usd");

    const result = await provider.chargeRemainderOffSession("pm_1", 9_000);

    expect(result).toBe("succeeded");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9_000, currency: "usd", payment_method: "pm_1", off_session: true, confirm: true }),
    );
  });

  it("returns 'requires_action' when Stripe reports that status", async () => {
    const create = vi.fn(async () => ({ status: "requires_action" }));
    const provider = new StripePaymentProvider(fakeStripe({ create }), "usd");

    expect(await provider.chargeRemainderOffSession("pm_1", 9_000)).toBe("requires_action");
  });

  it("returns 'requires_action' when Stripe throws an authentication_required card error", async () => {
    const create = vi.fn(async () => {
      const err: any = new Error("authentication required");
      err.code = "authentication_required";
      throw err;
    });
    const provider = new StripePaymentProvider(fakeStripe({ create }), "usd");

    expect(await provider.chargeRemainderOffSession("pm_1", 9_000)).toBe("requires_action");
  });

  it("returns 'failed' for any other decline or error", async () => {
    const create = vi.fn(async () => {
      throw new Error("card_declined");
    });
    const provider = new StripePaymentProvider(fakeStripe({ create }), "usd");

    expect(await provider.chargeRemainderOffSession("pm_1", 9_000)).toBe("failed");
  });

  it("returns 'failed' when Stripe resolves with a non-succeeded, non-requires_action status", async () => {
    const create = vi.fn(async () => ({ status: "canceled" }));
    const provider = new StripePaymentProvider(fakeStripe({ create }), "usd");

    expect(await provider.chargeRemainderOffSession("pm_1", 9_000)).toBe("failed");
  });

  it("refund creates a Stripe refund for the deposit PaymentIntent", async () => {
    const createRefund = vi.fn(async () => ({}));
    const provider = new StripePaymentProvider(fakeStripe({ createRefund }), "usd");

    await provider.refund("pi_1");

    expect(createRefund).toHaveBeenCalledWith({ payment_intent: "pi_1" });
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npm test --workspace=apps/api -- StripePaymentProvider.test.ts`
Expected: FAIL (`../../src/payments/StripePaymentProvider` does not exist)

- [ ] **Step 5: Implement**

Create `apps/api/src/payments/StripePaymentProvider.ts`:

```ts
import type Stripe from "stripe";
import type { PaymentProvider } from "engine/payments/PaymentProvider";

export class StripePaymentProvider implements PaymentProvider {
  constructor(
    private readonly stripe: Stripe,
    private readonly currency: string,
  ) {}

  async chargeRemainderOffSession(paymentMethodRef: string, amountCents: number): Promise<"succeeded" | "requires_action" | "failed"> {
    try {
      const intent = await this.stripe.paymentIntents.create({
        amount: amountCents,
        currency: this.currency,
        payment_method: paymentMethodRef,
        off_session: true,
        confirm: true,
      });

      if (intent.status === "succeeded") return "succeeded";
      if (intent.status === "requires_action") return "requires_action";
      return "failed";
    } catch (err: any) {
      // Stripe throws a StripeCardError for a synchronously-declined confirm
      // attempt; authentication_required is the specific code for "this
      // saved card still needs SCA" even off-session.
      if (err?.code === "authentication_required") return "requires_action";
      return "failed";
    }
  }

  async refund(depositRef: string): Promise<void> {
    await this.stripe.refunds.create({ payment_intent: depositRef });
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npm test --workspace=apps/api -- StripePaymentProvider.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/payments/StripePaymentProvider.ts apps/api/tests/payments/StripePaymentProvider.test.ts apps/api/package.json apps/api/package-lock.json apps/api/.env.example
git commit -m "feat(api): add StripePaymentProvider implementing the engine's PaymentProvider"
```

---

### Task 11: `GET /current-round` and `POST /rounds/:id/join`

**Files:**
- Create: `apps/api/src/routes/currentRound.ts`
- Create: `apps/api/src/routes/joinRound.ts`
- Create: `apps/api/src/stripeClient.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/tests/currentRound.test.ts`
- Test: `apps/api/tests/joinRound.test.ts`
- Modify (test): `apps/api/tests/scene.test.ts`, `apps/api/tests/leaderboard.test.ts` — add a
  `stripeClient` mock now that `server.ts` imports it unconditionally (see Step 7)

**Interfaces:**
- Consumes: `getCurrentRoundInfo` (Task 9), `getRoundParticipant` (`engine/db/repository`,
  Task 4), `StripePaymentProvider`'s underlying `Stripe` client instance (Task 10;
  `POST /rounds/:id/join` talks to the Stripe SDK directly to create the deposit
  PaymentIntent — this is intentionally outside the engine's `PaymentProvider` abstraction, per
  the spec: deposit creation is an `apps/api`-only concern).
- Produces:
  - `registerCurrentRoundRoute(app: FastifyInstance): void` — `GET /current-round`.
  - `registerJoinRoundRoute(app: FastifyInstance, stripe: Stripe, currency: string): void` —
    `POST /rounds/:id/join`, body `{ bidderId: string }`, returns
    `{ clientSecret: string; depositCents: number }` on success (200), `{ error: string }` with
    400 for a missing `bidderId`, 404 if there's no active reign, 409 if this bidder already
    joined this round.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/currentRound.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

// Not testing anything Stripe-related here, but server.ts now imports
// stripeClient.ts unconditionally (Step 3 below), and that module throws at
// import time if STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET aren't set — mock it
// away so this test doesn't need real Stripe env vars just to build the app.
vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("engine/queries/publicScene", () => ({
  getCurrentRoundInfo: vi.fn(async () => ({
    roundId: "round-1",
    phase: "bidding",
    currentLeaderCents: 421_000,
    depositCents: 42_100,
    biddingClosesAt: new Date("2026-09-22T12:00:00.000Z"),
  })),
}));

describe("GET /current-round", () => {
  it("returns the current round info as JSON", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/current-round" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.roundId).toBe("round-1");
    expect(body.depositCents).toBe(42_100);
    expect(body.biddingClosesAt).toBe("2026-09-22T12:00:00.000Z");
  });

  it("returns null (not an error) when there's no active reign yet", async () => {
    const { getCurrentRoundInfo } = await import("engine/queries/publicScene");
    vi.mocked(getCurrentRoundInfo).mockResolvedValueOnce(null);

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/current-round" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
  });
});
```

Create `apps/api/tests/joinRound.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

const createPaymentIntent = vi.fn(async () => ({ client_secret: "pi_1_secret", id: "pi_1" }));

vi.mock("engine/db/repository", () => ({
  getRoundParticipant: vi.fn(async () => null),
  getCurrentReign: vi.fn(async () => ({ id: "reign-1", occupantId: "champ", priceCents: 10_000, startedAt: new Date(), endedAt: null })),
}));

vi.mock("../src/stripeClient", () => ({
  stripe: { paymentIntents: { create: createPaymentIntent } },
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

describe("POST /rounds/:id/join", () => {
  it("creates a deposit PaymentIntent and returns its client secret", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/rounds/round-1/join",
      payload: { bidderId: "challenger" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.clientSecret).toBe("pi_1_secret");
    expect(body.depositCents).toBe(1_000); // 10% of the reign's 10_000 priceCents
    expect(createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1_000, setup_future_usage: "off_session", metadata: { roundId: "round-1", bidderId: "challenger" } }),
    );
  });

  it("rejects a missing bidderId with 400", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join", payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("rejects with 404 when there's no active reign", async () => {
    const { getCurrentReign } = await import("engine/db/repository");
    vi.mocked(getCurrentReign).mockResolvedValueOnce(null);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join", payload: { bidderId: "challenger" } });
    expect(response.statusCode).toBe(404);
  });

  it("rejects with 409 when this bidder already joined this round", async () => {
    const { getRoundParticipant } = await import("engine/db/repository");
    vi.mocked(getRoundParticipant).mockResolvedValueOnce({
      id: "p1", roundId: "round-1", bidderId: "challenger", depositCents: 1_000, depositRef: "pi_0", paymentMethodRef: "pm_0", depositStatus: "held", joinedAt: new Date(),
    } as any);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join", payload: { bidderId: "challenger" } });
    expect(response.statusCode).toBe(409);
  });
});
```

- [ ] **Step 2: Run to verify both fail**

Run: `npm test --workspace=apps/api -- currentRound.test.ts joinRound.test.ts`
Expected: FAIL (routes and `../src/stripeClient` don't exist yet)

- [ ] **Step 3: Add a shared Stripe client module**

Create `apps/api/src/stripeClient.ts`:

```ts
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
```

- [ ] **Step 4: Implement `GET /current-round`**

Create `apps/api/src/routes/currentRound.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { getCurrentRoundInfo } from "engine/queries/publicScene";

export function registerCurrentRoundRoute(app: FastifyInstance): void {
  app.get("/current-round", async () => {
    return getCurrentRoundInfo(new Date());
  });
}
```

- [ ] **Step 5: Implement `POST /rounds/:id/join`**

Create `apps/api/src/routes/joinRound.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { getRoundParticipant, getCurrentReign } from "engine/db/repository";
import { calculateDeposit } from "engine/domain/deposit";

export function registerJoinRoundRoute(app: FastifyInstance, stripe: Stripe, currency: string): void {
  app.post<{ Params: { id: string }; Body: { bidderId?: string } }>("/rounds/:id/join", async (request, reply) => {
    const { id: roundId } = request.params;
    const { bidderId } = request.body ?? {};

    if (!bidderId) {
      reply.code(400);
      return { error: "bidderId is required" };
    }

    const existing = await getRoundParticipant(roundId, bidderId);
    if (existing) {
      reply.code(409);
      return { error: "already joined this round" };
    }

    const reign = await getCurrentReign();
    if (!reign) {
      reply.code(404);
      return { error: "no active reign" };
    }

    const depositCents = calculateDeposit(reign.priceCents);

    const intent = await stripe.paymentIntents.create({
      amount: depositCents,
      currency,
      setup_future_usage: "off_session",
      metadata: { roundId, bidderId },
    });

    return { clientSecret: intent.client_secret, depositCents };
  });
}
```

- [ ] **Step 6: Wire both routes into `buildServer()`**

Modify `apps/api/src/server.ts` to:

```ts
import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";
import { registerSceneRoute } from "./routes/scene";
import { registerLeaderboardRoute } from "./routes/leaderboard";
import { registerCurrentRoundRoute } from "./routes/currentRound";
import { registerJoinRoundRoute } from "./routes/joinRound";
import { stripe, STRIPE_CURRENCY } from "./stripeClient";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  registerSceneRoute(app);
  registerLeaderboardRoute(app);
  registerCurrentRoundRoute(app);
  registerJoinRoundRoute(app, stripe, STRIPE_CURRENCY);
  return app;
}
```

- [ ] **Step 7: Patch the pre-existing `scene.test.ts`/`leaderboard.test.ts` — they now transitively import `stripeClient.ts` too**

`server.ts` (Step 6) imports `stripeClient.ts` unconditionally, and that module throws at
import time without real `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` env vars. Both
`scene.test.ts` and `leaderboard.test.ts` call `buildServer()` and previously had no reason to
know `stripeClient.ts` exists — add the same mock `currentRound.test.ts` uses.

In `apps/api/tests/scene.test.ts`, add right after the `import { buildServer } ...` line:

```ts
vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));
```

Do the same in `apps/api/tests/leaderboard.test.ts`, right after its `import { buildServer } ...` line.

- [ ] **Step 8: Run tests**

Run: `npm test --workspace=apps/api -- currentRound.test.ts joinRound.test.ts scene.test.ts leaderboard.test.ts`
Expected: PASS (all tests — confirms the pre-existing scene/leaderboard routes still work with
the new `stripeClient` import added to `server.ts`)

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/stripeClient.ts apps/api/src/routes/currentRound.ts apps/api/src/routes/joinRound.ts apps/api/src/server.ts apps/api/tests/currentRound.test.ts apps/api/tests/joinRound.test.ts apps/api/tests/scene.test.ts apps/api/tests/leaderboard.test.ts
git commit -m "feat(api): add GET /current-round and POST /rounds/:id/join"
```

---

### Task 12: `POST /bids`

**Files:**
- Create: `apps/api/src/routes/placeBid.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/tests/placeBid.test.ts`

**Interfaces:**
- Consumes: `placeBid` (`engine/engine/placeBid`, Task 6).
- Produces: `registerPlaceBidRoute(app: FastifyInstance): void` — `POST /bids`, body
  `{ bidderId: string; amountCents: number }`, returns `{ bidId: string }` (200) on success,
  `{ error: string }` with 400 for a malformed body or 422 for a rejected bid (banned, wrong
  phase, hasn't joined, amount too low/high/NaN — every reason `placeBid` can return).

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/placeBid.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

// See currentRound.test.ts — server.ts imports stripeClient.ts unconditionally,
// so every test that builds the app needs this mocked away unless it's
// actually testing Stripe behavior.
vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("engine/engine/placeBid", () => ({
  placeBid: vi.fn(async () => ({ ok: true, bidId: "bid-1" })),
}));

describe("POST /bids", () => {
  it("places a bid and returns its id", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/bids",
      payload: { bidderId: "challenger", amountCents: 11_000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ bidId: "bid-1" });
  });

  it("rejects a malformed body with 400", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/bids", payload: { bidderId: "challenger" } });
    expect(response.statusCode).toBe(400);
  });

  it("returns 422 with the engine's reason when placeBid rejects the bid", async () => {
    const { placeBid } = await import("engine/engine/placeBid");
    vi.mocked(placeBid).mockResolvedValueOnce({ ok: false, reason: "Join this round (pay the deposit) before placing a bid." });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/bids",
      payload: { bidderId: "challenger", amountCents: 11_000 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain("Join this round");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace=apps/api -- placeBid.test.ts`
Expected: FAIL (route and `engine/engine/placeBid` mock target don't exist in `server.ts` yet)

- [ ] **Step 3: Implement**

Create `apps/api/src/routes/placeBid.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { placeBid } from "engine/engine/placeBid";

export function registerPlaceBidRoute(app: FastifyInstance): void {
  app.post<{ Body: { bidderId?: string; amountCents?: number } }>("/bids", async (request, reply) => {
    const { bidderId, amountCents } = request.body ?? {};

    if (!bidderId || typeof amountCents !== "number") {
      reply.code(400);
      return { error: "bidderId and amountCents are required" };
    }

    const result = await placeBid({ bidderId, amountCents, now: new Date() });
    if (!result.ok) {
      reply.code(422);
      return { error: result.reason };
    }

    return { bidId: result.bidId };
  });
}
```

Modify `apps/api/src/server.ts` to add the import and registration:

```ts
import { registerPlaceBidRoute } from "./routes/placeBid";
```

```ts
  registerPlaceBidRoute(app);
```

(inserted alongside the other `register*Route(app)` calls in `buildServer()`)

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=apps/api -- placeBid.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/placeBid.ts apps/api/src/server.ts apps/api/tests/placeBid.test.ts
git commit -m "feat(api): add POST /bids"
```

---

### Task 13: `POST /webhooks/stripe`

**Files:**
- Modify: `apps/api/src/server.ts` (raw-body capture for signature verification)
- Create: `apps/api/src/routes/stripeWebhook.ts`
- Test: `apps/api/tests/stripeWebhook.test.ts`

**Interfaces:**
- Consumes: `joinRound` (`engine/engine/joinRound`, Task 5), `stripe`, `STRIPE_WEBHOOK_SECRET`
  env var.
- Produces: `registerStripeWebhookRoute(app: FastifyInstance, stripe: Stripe, webhookSecret: string, provider: PaymentProvider): void`
  — `POST /webhooks/stripe`. Verifies the `stripe-signature` header against the raw request
  body; on a valid `payment_intent.succeeded` event with `roundId`/`bidderId` metadata, calls
  `joinRound`. Always responds `{ received: true }` on success (200) so Stripe doesn't retry a
  successfully-processed event; responds 400 on a missing/invalid signature.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/stripeWebhook.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

const constructEvent = vi.fn();
const joinRoundMock = vi.fn(async () => ({ outcome: "joined" }));

vi.mock("../src/stripeClient", () => ({
  stripe: { webhooks: { constructEvent } },
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("engine/engine/joinRound", () => ({
  joinRound: joinRoundMock,
}));

describe("POST /webhooks/stripe", () => {
  it("rejects a request with no stripe-signature header", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/webhooks/stripe", payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a request whose signature fails verification", async () => {
    constructEvent.mockImplementationOnce(() => {
      throw new Error("invalid signature");
    });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "bad" },
      payload: { hello: "world" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("calls joinRound with the PaymentIntent's metadata and payment method on payment_intent.succeeded", async () => {
    constructEvent.mockReturnValueOnce({
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_1",
          amount: 1_000,
          payment_method: "pm_1",
          metadata: { roundId: "round-1", bidderId: "challenger" },
        },
      },
    });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "valid" },
      payload: { irrelevant: "raw body is what's actually verified" },
    });

    expect(response.statusCode).toBe(200);
    expect(joinRoundMock).toHaveBeenCalledWith(
      expect.objectContaining({ roundId: "round-1", bidderId: "challenger", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1" }),
      expect.anything(),
    );
  });

  it("ignores event types it doesn't handle, still returning 200", async () => {
    constructEvent.mockReturnValueOnce({ type: "payment_intent.created", data: { object: {} } });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "stripe-signature": "valid" },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(joinRoundMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace=apps/api -- stripeWebhook.test.ts`
Expected: FAIL (route doesn't exist; `server.ts` doesn't capture a raw body yet)

- [ ] **Step 3: Add raw-body capture to `server.ts`**

Fastify's default `application/json` parser only exposes parsed JSON — Stripe's signature check
needs the exact raw bytes. Replace `apps/api/src/server.ts` with:

```ts
import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";
import { registerSceneRoute } from "./routes/scene";
import { registerLeaderboardRoute } from "./routes/leaderboard";
import { registerCurrentRoundRoute } from "./routes/currentRound";
import { registerJoinRoundRoute } from "./routes/joinRound";
import { registerPlaceBidRoute } from "./routes/placeBid";
import { registerStripeWebhookRoute } from "./routes/stripeWebhook";
import { stripe, STRIPE_CURRENCY, STRIPE_WEBHOOK_SECRET } from "./stripeClient";
import { StripePaymentProvider } from "./payments/StripePaymentProvider";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  // Captures the raw request bytes onto request.rawBody in addition to the
  // normal parsed JSON body — Stripe's webhook signature check needs the
  // exact bytes Stripe signed, which JSON.stringify(JSON.parse(...)) is not
  // guaranteed to reproduce.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    try {
      const json = body.length ? JSON.parse(body.toString("utf8")) : {};
      done(null, json);
    } catch (err) {
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

  return app;
}
```

- [ ] **Step 4: Implement the route**

Create `apps/api/src/routes/stripeWebhook.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { joinRound } from "engine/engine/joinRound";
import type { PaymentProvider } from "engine/payments/PaymentProvider";

export function registerStripeWebhookRoute(
  app: FastifyInstance,
  stripe: Stripe,
  webhookSecret: string,
  provider: PaymentProvider,
): void {
  app.post("/webhooks/stripe", async (request, reply) => {
    const signature = request.headers["stripe-signature"];
    if (!signature || typeof signature !== "string") {
      reply.code(400);
      return { error: "missing stripe-signature header" };
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(request.rawBody ?? Buffer.from(""), signature, webhookSecret);
    } catch {
      reply.code(400);
      return { error: "invalid signature" };
    }

    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object as Stripe.PaymentIntent;
      const roundId = intent.metadata?.roundId;
      const bidderId = intent.metadata?.bidderId;
      if (roundId && bidderId && typeof intent.payment_method === "string") {
        await joinRound(
          {
            roundId,
            bidderId,
            depositCents: intent.amount,
            depositRef: intent.id,
            paymentMethodRef: intent.payment_method,
            now: new Date(),
          },
          provider,
        );
      }
    }

    return { received: true };
  });
}
```

- [ ] **Step 5: Run tests**

Run: `npm test --workspace=apps/api -- stripeWebhook.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Run the full `apps/api` test suite**

Run: `npm test --workspace=apps/api`
Expected: PASS (every test file — confirms the raw-body content-type parser change in
`server.ts` didn't break `scene.test.ts`/`leaderboard.test.ts`, which post no bodies but do
exercise `buildServer()`)

- [ ] **Step 7: Run typecheck across both workspaces**

Run: `npm run typecheck --workspace=apps/engine && npm run typecheck --workspace=apps/api`
Expected: no errors

- [ ] **Step 8: Manual pre-merge verification against live Stripe test mode**

This step needs a real (test-mode) Stripe account and is not part of the automated suite — do
it once before the branch is reviewed/merged:

1. Set `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` in `apps/api/.env` from the Stripe Dashboard
   test-mode keys and `stripe listen --print-secret`.
2. Run `stripe listen --forward-to localhost:3001/webhooks/stripe` in one terminal.
3. Start `apps/api` (`npm run dev --workspace=apps/api`) and `apps/engine`'s DB.
4. Bootstrap a reign (via a small script or the existing `createInitialReign` call from a test
   harness), then `curl -X POST localhost:3001/rounds/<roundId>/join -d '{"bidderId":"me"}'
   -H 'content-type: application/json'` to get a `clientSecret`.
5. Confirm the PaymentIntent using Stripe's test card `4242 4242 4242 4242` (any future expiry,
   any CVC) via `stripe.confirmCardPayment` in a minimal browser snippet, or Stripe's own
   testing tools — confirm the webhook fires and `joinRound` runs (check the `round_participants`
   row lands with `depositStatus: "held"`).
6. Repeat with test card `4000 0025 0000 3155` to exercise the `requires_action`/3DS path for
   the deposit confirmation.
7. Manually trigger a `tick()` (or run the engine's scheduler) past the bidding window with a
   placed bid, and confirm the remainder off-session charge actually reaches Stripe (check the
   Stripe Dashboard's test-mode Payments list for the second PaymentIntent).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/server.ts apps/api/src/routes/stripeWebhook.ts apps/api/tests/stripeWebhook.test.ts
git commit -m "feat(api): add POST /webhooks/stripe with signature verification"
```

---

## After This Plan

Two follow-up plans, in order:

1. **Frontend wiring** (`apps/web`): Stripe Elements UI in `AuctionFlow.tsx` — a "Join" step
   that calls `POST /rounds/:id/join`, renders Stripe's card form, confirms the PaymentIntent,
   then unlocks free bid submission via `POST /bids`; plus polling/fetching `GET /current-round`
   for live bidding state (the static build-time `getScene`/`getLeaderboard` data stays as the
   initial paint, per the existing architecture — this only adds the live layer on top). Needs a
   client-side `bidderId` (an opaque, locally-generated id persisted in a cookie/localStorage —
   there is no real auth yet, matching this plan's Global Constraints).
2. **Deployment** (job-link-boil's Helsinki k3s cluster): new `oneabobeall` namespace, own
   Postgres, Traefik `Ingress`+`Middleware` for path-based routing (`oneabobeall.org/api/*`,
   reusing the apex cert the same way `zavodhr.ru/storage` reuses `zavodhr-tls`), Kubernetes
   secrets for `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`DATABASE_URL`, mirroring
   `job-link-boil/infra/scripts/deploy.sh`'s build-locally-then-`k3s ctr images import` flow.

Also still open, unrelated to this plan and not blocking it: the `public-page-delivery-design.md`
amendment noting the new live endpoints (spec Section 5 already documents the reasoning; the doc
itself hasn't been edited yet), and the pre-existing "stranded state" gaps in `apps/engine`
noted in past reviews (a process crash leaving an offer in `"processing"` or a round in
`"resolving"` — this plan's `settleRound` crash-recovery poll narrows but does not eliminate
that residual window, same as before).
