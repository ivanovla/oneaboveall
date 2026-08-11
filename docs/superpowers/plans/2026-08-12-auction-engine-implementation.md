# Auction Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the auction domain engine described in [2026-08-06-auction-engine-design.md](../specs/2026-08-06-auction-engine-design.md) — the champion/reign/round/bid state machine, deposits, the payment cascade, and the read queries the public page needs — as a standalone, fully-tested TypeScript package with no UI, auth, or real payment provider attached.

**Architecture:** A pure-function domain layer (validation, deposit math) sits on top of a PostgreSQL persistence layer (via Drizzle ORM), with all cross-row invariants (queue leadership, phase transitions) enforced through explicit repository functions rather than scattered inline queries. Time-dependent behavior (round phases, payment deadlines) is driven by an injected `now: Date` rather than the system clock, so every scenario in the spec's state machine can be tested deterministically. A `PaymentProvider` interface isolates the engine from real payment integration; a `FakePaymentProvider` is used everywhere in this plan.

**Tech Stack:** TypeScript, Node.js, PostgreSQL, Drizzle ORM, Vitest, `pg` driver. Local/test database via Docker Compose.

## Global Constraints

- Minimum bid increment: **$1** (100 cents) above the current leader (champion price, or top queued bid) — [spec](../specs/2026-08-06-auction-engine-design.md).
- Deposit: **10%** of the bid amount, capped at **$1,000** (100,000 cents) — [ui-reference spec](../specs/2026-08-12-ui-reference.md) pins the percentage the engine spec left as "a fixed percentage."
- Round = **24h**, split into a **12h bidding phase** then a **12h payment/cascade phase** (a single shared budget across the whole cascade, not per-bidder).
- Each cascade payment attempt gets up to **1h**, bounded by whatever remains of the round's shared 12h payment budget.
- Non-payment penalty: deposit forfeited, bidder **banned for 3 rounds** (~3 days).
- Deposit refunds for non-winning bidders happen only after the round fully resolves, never incrementally.
- All monetary amounts are **integer minor units** (cents) internally; no currency/display conversion in this layer.
- Bans are enforced at bid placement, not just at resolution time.
- Ties break by earliest `placed_at`.
- Before any champion exists, a fixed configured starting price applies with no auction — first payer becomes champion.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, drizzle.config.ts, docker-compose.yml, .env.example
src/
  domain/
    config.ts           # tunable constants from Global Constraints
    types.ts             # Bid, Round, Reign shared types
    deposit.ts            # calculateDeposit()
    bidValidation.ts       # validateBidAmount()
  payments/
    PaymentProvider.ts     # interface
    FakePaymentProvider.ts # test double
  db/
    schema.ts             # Drizzle table defs
    client.ts              # db connection
    repository.ts           # atomic reads/writes
  engine/
    bootstrap.ts           # createInitialReign()
    placeBid.ts             # placeBid() use case
    roundResolution.ts       # snapshot + payment cascade + champion install
    scheduler.ts              # tick(now) driver
  queries/
    publicScene.ts           # getScene(), getLeaderboard()
tests/
  domain/deposit.test.ts, domain/bidValidation.test.ts
  db/repository.test.ts
  payments/FakePaymentProvider.test.ts
  engine/bootstrap.test.ts, engine/placeBid.test.ts, engine/roundResolution.test.ts, engine/scheduler.test.ts
  queries/publicScene.test.ts
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `docker-compose.yml`, `.env.example`, `.gitignore`, `src/index.ts`, `tests/smoke.test.ts`

**Interfaces:**
- Produces: a working `npm test` / `npm run typecheck` toolchain every later task builds on. No domain code yet.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "auction-engine",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "db:push": "drizzle-kit push"
  },
  "dependencies": {
    "drizzle-orm": "^0.33.0",
    "pg": "^8.12.0"
  },
  "devDependencies": {
    "@types/node": "^22.5.0",
    "@types/pg": "^8.11.6",
    "drizzle-kit": "^0.24.2",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist"
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15000,
  },
});
```

- [ ] **Step 4: Create `docker-compose.yml`**

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: auction
      POSTGRES_PASSWORD: auction
      POSTGRES_DB: auction_engine_test
    ports:
      - "5433:5432"
```

- [ ] **Step 5: Create `.env.example`**

```
DATABASE_URL=postgres://auction:auction@localhost:5433/auction_engine_test
```

- [ ] **Step 6: Create `.gitignore`**

```
node_modules
dist
.env
```

- [ ] **Step 7: Create `src/index.ts`**

```ts
export const AUCTION_ENGINE_VERSION = "0.1.0";
```

- [ ] **Step 8: Create `tests/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { AUCTION_ENGINE_VERSION } from "../src/index";

describe("scaffold", () => {
  it("package resolves", () => {
    expect(AUCTION_ENGINE_VERSION).toBe("0.1.0");
  });
});
```

- [ ] **Step 9: Install and verify**

Run: `npm install && npm run typecheck && npm test`
Expected: install succeeds, typecheck passes with no errors, `1 passed` test.

- [ ] **Step 10: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts docker-compose.yml .env.example .gitignore src/index.ts tests/smoke.test.ts package-lock.json
git commit -m "chore: scaffold auction-engine TypeScript project"
```

---

### Task 2: Domain config and deposit calculation

**Files:**
- Create: `src/domain/config.ts`, `src/domain/deposit.ts`
- Test: `tests/domain/deposit.test.ts`

**Interfaces:**
- Produces: `MIN_INCREMENT_CENTS`, `DEPOSIT_PERCENT`, `DEPOSIT_CAP_CENTS`, `BIDDING_PHASE_MS`, `PAYMENT_PHASE_MS`, `ROUND_MS`, `PAYMENT_ATTEMPT_MS`, `BAN_ROUNDS`, `STARTING_PRICE_CENTS` (all `number`) from `config.ts`; `calculateDeposit(bidAmountCents: number): number` from `deposit.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/domain/deposit.test.ts
import { describe, it, expect } from "vitest";
import { calculateDeposit } from "../../src/domain/deposit";

describe("calculateDeposit", () => {
  it("is 10% of the bid", () => {
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

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/domain/deposit.test.ts`
Expected: FAIL — cannot find module `../../src/domain/deposit`.

- [ ] **Step 3: Write `src/domain/config.ts`**

```ts
export const MIN_INCREMENT_CENTS = 100; // $1

export const DEPOSIT_PERCENT = 0.10;
export const DEPOSIT_CAP_CENTS = 100_000; // $1,000

export const BIDDING_PHASE_MS = 12 * 60 * 60 * 1000;
export const PAYMENT_PHASE_MS = 12 * 60 * 60 * 1000;
export const ROUND_MS = BIDDING_PHASE_MS + PAYMENT_PHASE_MS;
export const PAYMENT_ATTEMPT_MS = 60 * 60 * 1000; // 1h per cascade attempt

export const BAN_ROUNDS = 3;
export const BAN_DURATION_MS = BAN_ROUNDS * ROUND_MS;

// Fixed price to become champion when no reign exists yet. Configurable later;
// there is nothing to out-bid before the first champion.
export const STARTING_PRICE_CENTS = 10_000; // $100
```

- [ ] **Step 4: Write `src/domain/deposit.ts`**

```ts
import { DEPOSIT_PERCENT, DEPOSIT_CAP_CENTS } from "./config";

export function calculateDeposit(bidAmountCents: number): number {
  return Math.min(DEPOSIT_CAP_CENTS, Math.round(bidAmountCents * DEPOSIT_PERCENT));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/domain/deposit.test.ts`
Expected: PASS — 4 tests passed.

- [ ] **Step 6: Commit**

```bash
git add src/domain/config.ts src/domain/deposit.ts tests/domain/deposit.test.ts
git commit -m "feat: add deposit calculation"
```

---

### Task 3: Bid amount validation

**Files:**
- Create: `src/domain/bidValidation.ts`
- Test: `tests/domain/bidValidation.test.ts`

**Interfaces:**
- Consumes: `MIN_INCREMENT_CENTS` from `src/domain/config.ts` (Task 2).
- Produces: `validateBidAmount(bidAmountCents: number, currentLeaderCents: number): { valid: true } | { valid: false; reason: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/domain/bidValidation.test.ts
import { describe, it, expect } from "vitest";
import { validateBidAmount } from "../../src/domain/bidValidation";

describe("validateBidAmount", () => {
  it("rejects a bid equal to the current leader", () => {
    const result = validateBidAmount(10_000, 10_000);
    expect(result.valid).toBe(false);
  });

  it("rejects a bid less than one increment above the leader", () => {
    const result = validateBidAmount(10_050, 10_000);
    expect(result.valid).toBe(false);
  });

  it("accepts a bid exactly one increment above the leader", () => {
    const result = validateBidAmount(10_100, 10_000);
    expect(result.valid).toBe(true);
  });

  it("accepts a bid well above the leader", () => {
    const result = validateBidAmount(20_000, 10_000);
    expect(result.valid).toBe(true);
  });

  it("includes a human-readable reason when rejected", () => {
    const result = validateBidAmount(10_000, 10_000);
    if (result.valid) throw new Error("expected invalid");
    expect(result.reason).toContain("10100");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/domain/bidValidation.test.ts`
Expected: FAIL — cannot find module `../../src/domain/bidValidation`.

- [ ] **Step 3: Write `src/domain/bidValidation.ts`**

```ts
import { MIN_INCREMENT_CENTS } from "./config";

export type BidValidationResult = { valid: true } | { valid: false; reason: string };

export function validateBidAmount(bidAmountCents: number, currentLeaderCents: number): BidValidationResult {
  const minAllowed = currentLeaderCents + MIN_INCREMENT_CENTS;
  if (bidAmountCents < minAllowed) {
    return {
      valid: false,
      reason: `Bid must be at least ${minAllowed} cents (current leader ${currentLeaderCents} + minimum increment ${MIN_INCREMENT_CENTS}).`,
    };
  }
  return { valid: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/domain/bidValidation.test.ts`
Expected: PASS — 5 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/domain/bidValidation.ts tests/domain/bidValidation.test.ts
git commit -m "feat: add bid amount validation"
```

---

### Task 4: Database schema, client, and migration

**Files:**
- Create: `drizzle.config.ts`, `src/db/schema.ts`, `src/db/client.ts`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Produces: Drizzle tables `reigns`, `rounds`, `bids`, `paymentOffers`, `bans`; `db` client instance from `src/db/client.ts`.
- Requires: local Postgres running (`docker compose up -d db`) and `DATABASE_URL` set (copy `.env.example` to `.env`).

- [ ] **Step 1: Write `src/db/schema.ts`**

```ts
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
```

- [ ] **Step 2: Write `drizzle.config.ts`**

```ts
import { defineConfig } from "drizzle-kit";
import "dotenv/config";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

- [ ] **Step 3: Add `dotenv` dependency and update `package.json`**

Run: `npm install dotenv`

- [ ] **Step 4: Write `src/db/client.ts`**

```ts
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
export { pool };
```

- [ ] **Step 5: Start the local database and push the schema**

Run: `cp .env.example .env && docker compose up -d db && sleep 2 && npm run db:push`
Expected: drizzle-kit reports the 5 tables created with no errors.

- [ ] **Step 6: Write the smoke test**

```ts
// tests/db/schema.test.ts
import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns } from "../../src/db/schema";

describe("schema", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("can insert and read a reign", async () => {
    const [inserted] = await db
      .insert(reigns)
      .values({ occupantId: "test-user", priceCents: 10_000, startedAt: new Date() })
      .returning();

    const [found] = await db.select().from(reigns).where(eq(reigns.id, inserted.id)).limit(1);
    expect(found?.occupantId).toBe("test-user");

    await db.delete(reigns).where(eq(reigns.id, inserted.id));
  });
});
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run tests/db/schema.test.ts`
Expected: PASS — 1 test passed. If it fails with a connection error, confirm `docker compose ps` shows `db` healthy and `.env` is present.

- [ ] **Step 8: Commit**

```bash
git add drizzle.config.ts src/db/schema.ts src/db/client.ts tests/db/schema.test.ts package.json package-lock.json drizzle
git commit -m "feat: add database schema and client"
```

---

### Task 5: PaymentProvider interface and fake

**Files:**
- Create: `src/payments/PaymentProvider.ts`, `src/payments/FakePaymentProvider.ts`
- Test: `tests/payments/FakePaymentProvider.test.ts`

**Interfaces:**
- Produces: `PaymentProvider` interface (`chargeDeposit`, `chargeRemainder`, `refund`); `FakePaymentProvider` class implementing it, plus `failNextRemainderCharge()` test control and `.charges` / `.refunds` inspection arrays.

- [ ] **Step 1: Write the failing test**

```ts
// tests/payments/FakePaymentProvider.test.ts
import { describe, it, expect } from "vitest";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";

describe("FakePaymentProvider", () => {
  it("charges a deposit and returns a ref", async () => {
    const provider = new FakePaymentProvider();
    const ref = await provider.chargeDeposit("bidder-1", 1_000);
    expect(ref).toBeTruthy();
    expect(provider.charges).toEqual([{ bidderId: "bidder-1", amountCents: 1_000, ref }]);
  });

  it("charges the remainder successfully by default", async () => {
    const provider = new FakePaymentProvider();
    const ref = await provider.chargeDeposit("bidder-1", 1_000);
    const ok = await provider.chargeRemainder("bidder-1", 9_000, ref);
    expect(ok).toBe(true);
  });

  it("fails the next remainder charge on request, then resets", async () => {
    const provider = new FakePaymentProvider();
    const ref = await provider.chargeDeposit("bidder-1", 1_000);
    provider.failNextRemainderCharge();
    expect(await provider.chargeRemainder("bidder-1", 9_000, ref)).toBe(false);
    expect(await provider.chargeRemainder("bidder-1", 9_000, ref)).toBe(true);
  });

  it("tracks refunds", async () => {
    const provider = new FakePaymentProvider();
    const ref = await provider.chargeDeposit("bidder-1", 1_000);
    await provider.refund(ref);
    expect(provider.refunds).toEqual([ref]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/payments/FakePaymentProvider.test.ts`
Expected: FAIL — cannot find module `../../src/payments/FakePaymentProvider`.

- [ ] **Step 3: Write `src/payments/PaymentProvider.ts`**

```ts
export interface PaymentProvider {
  chargeDeposit(bidderId: string, amountCents: number): Promise<string>;
  chargeRemainder(bidderId: string, amountCents: number, depositRef: string): Promise<boolean>;
  refund(depositRef: string): Promise<void>;
}
```

- [ ] **Step 4: Write `src/payments/FakePaymentProvider.ts`**

```ts
import type { PaymentProvider } from "./PaymentProvider";

export class FakePaymentProvider implements PaymentProvider {
  charges: { bidderId: string; amountCents: number; ref: string }[] = [];
  refunds: string[] = [];
  private failNextRemainder = false;

  async chargeDeposit(bidderId: string, amountCents: number): Promise<string> {
    const ref = `dep_${this.charges.length + 1}`;
    this.charges.push({ bidderId, amountCents, ref });
    return ref;
  }

  async chargeRemainder(_bidderId: string, _amountCents: number, _depositRef: string): Promise<boolean> {
    if (this.failNextRemainder) {
      this.failNextRemainder = false;
      return false;
    }
    return true;
  }

  async refund(depositRef: string): Promise<void> {
    this.refunds.push(depositRef);
  }

  failNextRemainderCharge(): void {
    this.failNextRemainder = true;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/payments/FakePaymentProvider.test.ts`
Expected: PASS — 4 tests passed.

- [ ] **Step 6: Commit**

```bash
git add src/payments tests/payments
git commit -m "feat: add PaymentProvider interface and fake"
```

---

### Task 6: Repository read helpers

**Files:**
- Create: `src/db/repository.ts`
- Test: `tests/db/repository.test.ts`

**Interfaces:**
- Consumes: `db` from `src/db/client.ts`, tables from `src/db/schema.ts` (Task 4).
- Produces: `getCurrentReign(): Promise<Reign | null>`, `getLatestRound(reignId: string): Promise<Round | null>`, `getQueueLeader(roundId: string): Promise<Bid | null>`, `isBanned(bidderId: string, now: Date): Promise<boolean>`. Also exports `Reign`, `Round`, `Bid` types (re-exported from `drizzle-orm`'s inferred row types) — later tasks import these from here rather than redefining them.

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/repository.test.ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans } from "../../src/db/schema";
import { getCurrentReign, getLatestRound, getQueueLeader, isBanned } from "../../src/db/repository";

afterEach(async () => {
  await db.delete(bids);
  await db.delete(bans);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

describe("getCurrentReign", () => {
  it("returns null when no reign exists", async () => {
    expect(await getCurrentReign()).toBeNull();
  });

  it("returns the reign with no endedAt", async () => {
    await db.insert(reigns).values([
      { occupantId: "old", priceCents: 5_000, startedAt: new Date(2026, 0, 1), endedAt: new Date(2026, 0, 2) },
      { occupantId: "current", priceCents: 10_000, startedAt: new Date(2026, 0, 2) },
    ]);
    const reign = await getCurrentReign();
    expect(reign?.occupantId).toBe("current");
  });
});

describe("getLatestRound", () => {
  it("returns the round that starts latest for a reign", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "u1", priceCents: 10_000, startedAt: new Date(2026, 0, 1) }).returning();
    await db.insert(rounds).values([
      { reignId: reign.id, startsAt: new Date(2026, 0, 1), phase: "closed" },
      { reignId: reign.id, startsAt: new Date(2026, 0, 2), phase: "bidding" },
    ]);
    const round = await getLatestRound(reign.id);
    expect(round?.phase).toBe("bidding");
  });
});

describe("getQueueLeader", () => {
  it("returns null for an empty queue", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "u1", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();
    expect(await getQueueLeader(round.id)).toBeNull();
  });

  it("returns the highest bid, tie-broken by earliest placedAt", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "u1", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();
    await db.insert(bids).values([
      { roundId: round.id, bidderId: "a", amountCents: 11_000, depositCents: 1_100, depositRef: "d1", placedAt: new Date(2026, 0, 1, 10, 0, 1) },
      { roundId: round.id, bidderId: "b", amountCents: 12_000, depositCents: 1_200, depositRef: "d2", placedAt: new Date(2026, 0, 1, 10, 0, 2) },
      { roundId: round.id, bidderId: "c", amountCents: 12_000, depositCents: 1_200, depositRef: "d3", placedAt: new Date(2026, 0, 1, 10, 0, 0) },
    ]);
    const leader = await getQueueLeader(round.id);
    expect(leader?.bidderId).toBe("c"); // tied on amount with b, but placed earliest
  });
});

describe("isBanned", () => {
  it("is false with no ban row", async () => {
    expect(await isBanned("u1", new Date())).toBe(false);
  });

  it("is true while a ban is active", async () => {
    await db.insert(bans).values({ bidderId: "u1", bannedUntil: new Date(2026, 0, 10) });
    expect(await isBanned("u1", new Date(2026, 0, 5))).toBe(true);
    expect(await isBanned("u1", new Date(2026, 0, 15))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/repository.test.ts`
Expected: FAIL — cannot find module `../../src/db/repository`.

- [ ] **Step 3: Write `src/db/repository.ts`**

```ts
import { and, desc, asc, eq, gt, isNull } from "drizzle-orm";
import { db } from "./client";
import { reigns, rounds, bids, bans } from "./schema";

export type Reign = typeof reigns.$inferSelect;
export type Round = typeof rounds.$inferSelect;
export type Bid = typeof bids.$inferSelect;

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

export async function getQueueLeader(roundId: string): Promise<Bid | null> {
  const [top] = await db
    .select()
    .from(bids)
    .where(eq(bids.roundId, roundId))
    .orderBy(desc(bids.amountCents), asc(bids.placedAt))
    .limit(1);
  return top ?? null;
}

export async function isBanned(bidderId: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select()
    .from(bans)
    .where(and(eq(bans.bidderId, bidderId), gt(bans.bannedUntil, now)))
    .limit(1);
  return !!row;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/repository.test.ts`
Expected: PASS — 6 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/db/repository.ts tests/db/repository.test.ts
git commit -m "feat: add repository read helpers"
```

---

### Task 7: Atomic bid placement (concurrency-safe)

**Files:**
- Modify: `src/db/repository.ts`
- Test: `tests/db/repository.placeBidAtomic.test.ts`

**Interfaces:**
- Consumes: `validateBidAmount` (Task 3), `Bid`/`Round`/`Reign` types (Task 6).
- Produces: `placeBidAtomic(params: { roundId: string; bidderId: string; amountCents: number; depositCents: number; depositRef: string }): Promise<{ ok: true; bid: Bid } | { ok: false; reason: string }>` — appended to `src/db/repository.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/repository.placeBidAtomic.test.ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids } from "../../src/db/schema";
import { placeBidAtomic } from "../../src/db/repository";

afterEach(async () => {
  await db.delete(bids);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

async function seedRound(priceCents: number) {
  const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents, startedAt: new Date() }).returning();
  const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();
  return round.id;
}

describe("placeBidAtomic", () => {
  it("accepts a valid first bid against the champion price", async () => {
    const roundId = await seedRound(10_000);
    const result = await placeBidAtomic({ roundId, bidderId: "a", amountCents: 10_100, depositCents: 1_010, depositRef: "d1" });
    expect(result.ok).toBe(true);
  });

  it("rejects a bid that doesn't beat the champion by the minimum increment", async () => {
    const roundId = await seedRound(10_000);
    const result = await placeBidAtomic({ roundId, bidderId: "a", amountCents: 10_050, depositCents: 1_005, depositRef: "d1" });
    expect(result.ok).toBe(false);
  });

  it("rejects a bid that doesn't beat the current queue leader", async () => {
    const roundId = await seedRound(10_000);
    await placeBidAtomic({ roundId, bidderId: "a", amountCents: 11_000, depositCents: 1_100, depositRef: "d1" });
    const second = await placeBidAtomic({ roundId, bidderId: "b", amountCents: 11_050, depositCents: 1_105, depositRef: "d2" });
    expect(second.ok).toBe(false);
  });

  it("accepts a bid that beats the current queue leader", async () => {
    const roundId = await seedRound(10_000);
    await placeBidAtomic({ roundId, bidderId: "a", amountCents: 11_000, depositCents: 1_100, depositRef: "d1" });
    const second = await placeBidAtomic({ roundId, bidderId: "b", amountCents: 11_100, depositCents: 1_110, depositRef: "d2" });
    expect(second.ok).toBe(true);
  });

  it("only lets one of two simultaneous equal-tier bids win the leader slot", async () => {
    const roundId = await seedRound(10_000);
    const [r1, r2] = await Promise.all([
      placeBidAtomic({ roundId, bidderId: "a", amountCents: 10_100, depositCents: 1_010, depositRef: "d1" }),
      placeBidAtomic({ roundId, bidderId: "b", amountCents: 10_100, depositCents: 1_010, depositRef: "d2" }),
    ]);
    const okCount = [r1, r2].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/repository.placeBidAtomic.test.ts`
Expected: FAIL — `placeBidAtomic` is not exported.

- [ ] **Step 3: Append `placeBidAtomic` to `src/db/repository.ts`**

Replace the file's import block (the top of `src/db/repository.ts`, currently `import { and, desc, asc, eq, gt, isNull } from "drizzle-orm";` plus the two lines under it) with:

```ts
import { and, desc, asc, eq, gt, isNull } from "drizzle-orm";
import { db } from "./client";
import { reigns, rounds, bids, bans } from "./schema";
import { validateBidAmount } from "../domain/bidValidation";
```

Add at the bottom of `src/db/repository.ts`, after the existing functions:

```ts
const SERIALIZATION_FAILURE = "40001";

export async function placeBidAtomic(params: {
  roundId: string;
  bidderId: string;
  amountCents: number;
  depositCents: number;
  depositRef: string;
}): Promise<{ ok: true; bid: Bid } | { ok: false; reason: string }> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await db.transaction(
        async (tx) => {
          const [round] = await tx.select().from(rounds).where(eq(rounds.id, params.roundId)).limit(1);
          if (!round) return { ok: false, reason: "Round not found." };

          const [reign] = await tx.select().from(reigns).where(eq(reigns.id, round.reignId)).limit(1);
          if (!reign) return { ok: false, reason: "Reign not found." };

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
              depositCents: params.depositCents,
              depositRef: params.depositRef,
              depositStatus: "held",
            })
            .returning();

          return { ok: true, bid: inserted };
        },
        { isolationLevel: "serializable" },
      );
    } catch (err: any) {
      if (err?.code === SERIALIZATION_FAILURE && attempt < maxAttempts) continue;
      throw err;
    }
  }
  throw new Error("placeBidAtomic: exceeded retry attempts under serialization conflict");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/repository.placeBidAtomic.test.ts`
Expected: PASS — 5 tests passed. The concurrency test relies on PostgreSQL's SERIALIZABLE isolation aborting one of the two conflicting transactions with SQLSTATE `40001`; the retry loop then re-validates it against the now-committed leader and correctly rejects it.

- [ ] **Step 5: Commit**

```bash
git add src/db/repository.ts tests/db/repository.placeBidAtomic.test.ts
git commit -m "feat: add concurrency-safe atomic bid placement"
```

---

### Task 8: Bootstrap — the first champion

**Files:**
- Create: `src/engine/bootstrap.ts`
- Test: `tests/engine/bootstrap.test.ts`

**Interfaces:**
- Consumes: `getCurrentReign` (Task 6), `STARTING_PRICE_CENTS` (Task 2), `db`, `reigns`, `rounds` tables.
- Produces: `createInitialReign(occupantId: string, now: Date): Promise<Reign>` — throws if a reign already exists. Also creates the reign's first `Round` row (`phase: "bidding"`, `startsAt: now`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine/bootstrap.test.ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { getCurrentReign, getLatestRound } from "../../src/db/repository";
import { STARTING_PRICE_CENTS } from "../../src/domain/config";

afterEach(async () => {
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

describe("createInitialReign", () => {
  it("installs the first champion at the fixed starting price", async () => {
    const now = new Date(2026, 0, 1, 12, 0, 0);
    const reign = await createInitialReign("first-user", now);
    expect(reign.priceCents).toBe(STARTING_PRICE_CENTS);
    expect(reign.occupantId).toBe("first-user");

    const current = await getCurrentReign();
    expect(current?.id).toBe(reign.id);
  });

  it("also creates the first round in the bidding phase", async () => {
    const now = new Date(2026, 0, 1, 12, 0, 0);
    const reign = await createInitialReign("first-user", now);
    const round = await getLatestRound(reign.id);
    expect(round?.phase).toBe("bidding");
    expect(round?.startsAt).toEqual(now);
  });

  it("refuses to bootstrap if a reign already exists", async () => {
    await createInitialReign("first-user", new Date(2026, 0, 1));
    await expect(createInitialReign("second-user", new Date(2026, 0, 2))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/bootstrap.test.ts`
Expected: FAIL — cannot find module `../../src/engine/bootstrap`.

- [ ] **Step 3: Write `src/engine/bootstrap.ts`**

```ts
import { db } from "../db/client";
import { reigns, rounds } from "../db/schema";
import { getCurrentReign, type Reign } from "../db/repository";
import { STARTING_PRICE_CENTS } from "../domain/config";

export async function createInitialReign(occupantId: string, now: Date): Promise<Reign> {
  const existing = await getCurrentReign();
  if (existing) {
    throw new Error("A reign already exists; cannot bootstrap again.");
  }

  const [reign] = await db
    .insert(reigns)
    .values({ occupantId, priceCents: STARTING_PRICE_CENTS, startedAt: now })
    .returning();

  await db.insert(rounds).values({ reignId: reign.id, startsAt: now, phase: "bidding" });

  return reign;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/bootstrap.test.ts`
Expected: PASS — 3 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/engine/bootstrap.ts tests/engine/bootstrap.test.ts
git commit -m "feat: add first-champion bootstrap"
```

---

### Task 9: `placeBid` use case (deposit charge + ban check)

**Files:**
- Create: `src/engine/placeBid.ts`
- Test: `tests/engine/placeBid.test.ts`

**Interfaces:**
- Consumes: `isBanned`, `getLatestRound`, `getCurrentReign`, `placeBidAtomic` (Task 6/7), `calculateDeposit` (Task 2), `PaymentProvider` (Task 5).
- Produces: `placeBid(params: { bidderId: string; amountCents: number; now: Date }, provider: PaymentProvider): Promise<{ ok: true; bidId: string; depositCents: number } | { ok: false; reason: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine/placeBid.test.ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { placeBid } from "../../src/engine/placeBid";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";

afterEach(async () => {
  await db.delete(bids);
  await db.delete(bans);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

describe("placeBid", () => {
  it("charges a 10% deposit and records the bid", async () => {
    await createInitialReign("champ", new Date(2026, 0, 1));
    const provider = new FakePaymentProvider();
    const result = await placeBid({ bidderId: "challenger", amountCents: 10_100, now: new Date(2026, 0, 1, 1) }, provider);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.depositCents).toBe(1_010);
    expect(provider.charges).toHaveLength(1);
    expect(provider.charges[0]).toMatchObject({ bidderId: "challenger", amountCents: 1_010 });
  });

  it("rejects a bid below the minimum increment without charging a deposit", async () => {
    await createInitialReign("champ", new Date(2026, 0, 1));
    const provider = new FakePaymentProvider();
    const result = await placeBid({ bidderId: "challenger", amountCents: 10_050, now: new Date(2026, 0, 1, 1) }, provider);
    expect(result.ok).toBe(false);
    expect(provider.charges).toHaveLength(0);
  });

  it("rejects a bid from a banned bidder without charging a deposit", async () => {
    await createInitialReign("champ", new Date(2026, 0, 1));
    await db.insert(bans).values({ bidderId: "challenger", bannedUntil: new Date(2026, 0, 10) });
    const provider = new FakePaymentProvider();
    const result = await placeBid({ bidderId: "challenger", amountCents: 20_000, now: new Date(2026, 0, 1, 1) }, provider);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("banned");
    expect(provider.charges).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/placeBid.test.ts`
Expected: FAIL — cannot find module `../../src/engine/placeBid`.

- [ ] **Step 3: Write `src/engine/placeBid.ts`**

```ts
import { getCurrentReign, getLatestRound, isBanned, placeBidAtomic } from "../db/repository";
import { calculateDeposit } from "../domain/deposit";
import type { PaymentProvider } from "../payments/PaymentProvider";

export async function placeBid(
  params: { bidderId: string; amountCents: number; now: Date },
  provider: PaymentProvider,
): Promise<{ ok: true; bidId: string; depositCents: number } | { ok: false; reason: string }> {
  if (await isBanned(params.bidderId, params.now)) {
    return { ok: false, reason: "This bidder is currently banned from placing bids." };
  }

  const reign = await getCurrentReign();
  if (!reign) return { ok: false, reason: "No active reign — the auction hasn't been bootstrapped yet." };

  const round = await getLatestRound(reign.id);
  if (!round || round.phase !== "bidding") {
    return { ok: false, reason: "This round is not accepting bids right now." };
  }

  const depositCents = calculateDeposit(params.amountCents);
  const depositRef = await provider.chargeDeposit(params.bidderId, depositCents);

  const result = await placeBidAtomic({
    roundId: round.id,
    bidderId: params.bidderId,
    amountCents: params.amountCents,
    depositCents,
    depositRef,
  });

  if (!result.ok) {
    await provider.refund(depositRef);
    return { ok: false, reason: result.reason };
  }

  return { ok: true, bidId: result.bid.id, depositCents };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/placeBid.test.ts`
Expected: PASS — 3 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/engine/placeBid.ts tests/engine/placeBid.test.ts
git commit -m "feat: add placeBid use case with deposit charge and ban check"
```

---

### Task 10: Bidding-phase snapshot resolution

**Files:**
- Create: `src/engine/roundResolution.ts`
- Test: `tests/engine/roundResolution.snapshot.test.ts`

**Interfaces:**
- Consumes: `getQueueLeader`, `db`, `rounds`, `paymentOffers` tables.
- Produces: `resolveBiddingPhaseSnapshot(roundId: string, now: Date): Promise<{ outcome: "empty-closed" | "offer-created" }>` — appended to `src/engine/roundResolution.ts` (new file, this task starts it).

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine/roundResolution.snapshot.test.ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, paymentOffers } from "../../src/db/schema";
import { resolveBiddingPhaseSnapshot } from "../../src/engine/roundResolution";
import { eq } from "drizzle-orm";
import { PAYMENT_ATTEMPT_MS, ROUND_MS, BIDDING_PHASE_MS } from "../../src/domain/config";

afterEach(async () => {
  await db.delete(paymentOffers);
  await db.delete(bids);
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

describe("resolveBiddingPhaseSnapshot", () => {
  it("closes the round with no change when the queue is empty", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);

    const result = await resolveBiddingPhaseSnapshot(roundId, snapshotAt);
    expect(result.outcome).toBe("empty-closed");

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("closed");
  });

  it("creates a payment offer for the snapshot leader when the queue is non-empty", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    const [bid] = await db
      .insert(bids)
      .values({ roundId, bidderId: "a", amountCents: 11_000, depositCents: 1_100, depositRef: "d1", placedAt: new Date(startsAt.getTime() + 1000) })
      .returning();
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);

    const result = await resolveBiddingPhaseSnapshot(roundId, snapshotAt);
    expect(result.outcome).toBe("offer-created");

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("payment");

    const [offer] = await db.select().from(paymentOffers).where(eq(paymentOffers.roundId, roundId));
    expect(offer.bidId).toBe(bid.id);
    expect(offer.status).toBe("pending");
    // 1h attempt window, bounded by the round's own 24h boundary — here the 1h window is the tighter bound.
    expect(offer.expiresAt.getTime()).toBe(Math.min(snapshotAt.getTime() + PAYMENT_ATTEMPT_MS, startsAt.getTime() + ROUND_MS));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/roundResolution.snapshot.test.ts`
Expected: FAIL — cannot find module `../../src/engine/roundResolution`.

- [ ] **Step 3: Write `src/engine/roundResolution.ts`**

```ts
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { rounds, paymentOffers } from "../db/schema";
import { getQueueLeader } from "../db/repository";
import { PAYMENT_ATTEMPT_MS, ROUND_MS } from "../domain/config";

export async function resolveBiddingPhaseSnapshot(
  roundId: string,
  now: Date,
): Promise<{ outcome: "empty-closed" | "offer-created" }> {
  const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId)).limit(1);
  if (!round) throw new Error("Round not found.");

  const leader = await getQueueLeader(roundId);

  if (!leader) {
    await db.update(rounds).set({ phase: "closed" }).where(eq(rounds.id, roundId));
    return { outcome: "empty-closed" };
  }

  const roundBoundary = new Date(round.startsAt.getTime() + ROUND_MS);
  const attemptExpiry = new Date(now.getTime() + PAYMENT_ATTEMPT_MS);
  const expiresAt = attemptExpiry.getTime() < roundBoundary.getTime() ? attemptExpiry : roundBoundary;

  await db.insert(paymentOffers).values({
    roundId,
    bidId: leader.id,
    offeredAt: now,
    expiresAt,
    status: "pending",
  });
  await db.update(rounds).set({ phase: "payment" }).where(eq(rounds.id, roundId));

  return { outcome: "offer-created" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/roundResolution.snapshot.test.ts`
Expected: PASS — 2 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/engine/roundResolution.ts tests/engine/roundResolution.snapshot.test.ts
git commit -m "feat: add bidding-phase snapshot resolution"
```

---

### Task 11: Champion installation

**Files:**
- Create: `src/engine/installChampion.ts`
- Test: `tests/engine/installChampion.test.ts`

**Interfaces:**
- Consumes: `db`, `reigns`, `rounds` tables, `getCurrentReign` (Task 6).
- Produces: `installChampion(occupantId: string, priceCents: number, now: Date, onInstalled?: (occupantId: string) => void): Promise<Reign>` — ends the current reign (`endedAt = now`), creates a new reign + its first round (`phase: "bidding"`), calls `onInstalled` if provided (this is the `on_champion_installed` interface point from the spec — a plain callback here; a real event bus is a later subsystem's concern).

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine/installChampion.test.ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { installChampion } from "../../src/engine/installChampion";
import { eq } from "drizzle-orm";

afterEach(async () => {
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

describe("installChampion", () => {
  it("ends the previous reign and starts a new one", async () => {
    const first = await createInitialReign("first", new Date(2026, 0, 1));
    const now = new Date(2026, 0, 2);

    const second = await installChampion("second", 11_000, now);

    const [endedFirst] = await db.select().from(reigns).where(eq(reigns.id, first.id));
    expect(endedFirst.endedAt).toEqual(now);

    expect(second.occupantId).toBe("second");
    expect(second.priceCents).toBe(11_000);
    expect(second.endedAt).toBeNull();
  });

  it("creates a fresh bidding-phase round for the new reign", async () => {
    await createInitialReign("first", new Date(2026, 0, 1));
    const now = new Date(2026, 0, 2);
    const second = await installChampion("second", 11_000, now);

    const [round] = await db.select().from(rounds).where(eq(rounds.reignId, second.id));
    expect(round.phase).toBe("bidding");
    expect(round.startsAt).toEqual(now);
  });

  it("invokes the onInstalled callback with the new occupant id", async () => {
    await createInitialReign("first", new Date(2026, 0, 1));
    let notified: string | null = null;
    await installChampion("second", 11_000, new Date(2026, 0, 2), (occupantId) => {
      notified = occupantId;
    });
    expect(notified).toBe("second");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/installChampion.test.ts`
Expected: FAIL — cannot find module `../../src/engine/installChampion`.

- [ ] **Step 3: Write `src/engine/installChampion.ts`**

```ts
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { reigns, rounds } from "../db/schema";
import { getCurrentReign, type Reign } from "../db/repository";

export async function installChampion(
  occupantId: string,
  priceCents: number,
  now: Date,
  onInstalled?: (occupantId: string) => void,
): Promise<Reign> {
  const current = await getCurrentReign();
  if (current) {
    await db.update(reigns).set({ endedAt: now }).where(eq(reigns.id, current.id));
  }

  const [reign] = await db.insert(reigns).values({ occupantId, priceCents, startedAt: now }).returning();
  await db.insert(rounds).values({ reignId: reign.id, startsAt: now, phase: "bidding" });

  onInstalled?.(occupantId);

  return reign;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/installChampion.test.ts`
Expected: PASS — 3 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/engine/installChampion.ts tests/engine/installChampion.test.ts
git commit -m "feat: add champion installation"
```

---

### Task 12: Payment resolution — success, cascade, and round exhaustion

**Files:**
- Modify: `src/engine/roundResolution.ts`
- Modify: `src/payments/FakePaymentProvider.ts` (add remainder-charge tracking — Task 5's fake only recorded `chargeDeposit` calls in `.charges`; this task's tests need to assert on `chargeRemainder` calls too, which is a distinct method)
- Test: `tests/engine/roundResolution.payment.test.ts`

**Interfaces:**
- Consumes: `installChampion` (Task 11), `getQueueLeader` (Task 6), `PAYMENT_ATTEMPT_MS`/`ROUND_MS`/`BAN_DURATION_MS` (Task 2), `bids`/`bans`/`paymentOffers`/`rounds` tables, `PaymentProvider` (Task 5).
- Produces two functions appended to `src/engine/roundResolution.ts`:
  - `confirmPayment(offerId: string, now: Date, provider: PaymentProvider, onInstalled?: (occupantId: string) => void): Promise<{ outcome: "paid" | "already-processed" }>`
  - `resolveExpiredOffer(offerId: string, now: Date, provider: PaymentProvider): Promise<{ outcome: "cascaded" | "round-closed" }>`
- Also produces: `FakePaymentProvider.remainderCharges: { bidderId: string; amountCents: number; depositRef: string }[]`, appended to by every `chargeRemainder` call (successful or not), analogous to the existing `.charges` array for deposits.

**Money-safety note (why `confirmPayment` claims before it charges):** Task 11's review flagged that `confirmPayment` as originally drafted had no idempotency guard — two concurrent calls for the same offer (a duplicate "Pay" submission: double-click, network retry, browser back-button resubmit) would both reach `provider.chargeRemainder` and charge the bidder twice for the same remainder. A `db.transaction` wrapper does NOT fix this: `chargeRemainder` is a call to an external payment provider, and a DB rollback cannot undo a real-world charge that already happened. The correct fix is an atomic **claim-before-charge**: a single conditional `UPDATE ... WHERE status = 'pending'` moves the offer to a `"processing"` state, and only the caller that actually wins that update (row count 1) proceeds to charge. A losing concurrent caller sees 0 rows updated and returns immediately without ever touching the payment provider. This requires one small schema change before writing `confirmPayment` — see Step 0.5 below.

- [ ] **Step 0: Extend `FakePaymentProvider` to record remainder charges**

In `src/payments/FakePaymentProvider.ts`, add a new public field and populate it inside `chargeRemainder`:

```ts
export class FakePaymentProvider implements PaymentProvider {
  charges: { bidderId: string; amountCents: number; ref: string }[] = [];
  remainderCharges: { bidderId: string; amountCents: number; depositRef: string }[] = [];
  refunds: string[] = [];
  private failNextRemainder = false;

  async chargeDeposit(bidderId: string, amountCents: number): Promise<string> {
    const ref = `dep_${this.charges.length + 1}`;
    this.charges.push({ bidderId, amountCents, ref });
    return ref;
  }

  async chargeRemainder(bidderId: string, amountCents: number, depositRef: string): Promise<boolean> {
    this.remainderCharges.push({ bidderId, amountCents, depositRef });
    if (this.failNextRemainder) {
      this.failNextRemainder = false;
      return false;
    }
    return true;
  }

  async refund(depositRef: string): Promise<void> {
    this.refunds.push(depositRef);
  }

  failNextRemainderCharge(): void {
    this.failNextRemainder = true;
  }
}
```

This replaces the whole class body from Task 5 — the only changes are the new `remainderCharges` field and the first line of `chargeRemainder`. Run `npx vitest run tests/payments/FakePaymentProvider.test.ts` after this change — it must still pass unmodified (the existing tests don't touch `remainderCharges`, so this is purely additive).

- [ ] **Step 0.5: Add a `"processing"` state to `offerStatusEnum`, for the claim-before-charge guard**

In `src/db/schema.ts`, change:

```ts
export const offerStatusEnum = pgEnum("offer_status", ["pending", "paid", "expired"]);
```

to:

```ts
export const offerStatusEnum = pgEnum("offer_status", ["pending", "processing", "paid", "expired"]);
```

Push the updated schema: `npm run db:push` (confirm it applies cleanly against the running local Postgres — this only adds an enum value, no existing rows are affected since none exist yet in this stage of development). Run `npx vitest run tests/db/schema.test.ts` after — it must still pass unmodified.

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine/roundResolution.payment.test.ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans, paymentOffers } from "../../src/db/schema";
import { resolveBiddingPhaseSnapshot, confirmPayment, resolveExpiredOffer } from "../../src/engine/roundResolution";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";
import { eq } from "drizzle-orm";
import { PAYMENT_ATTEMPT_MS, BIDDING_PHASE_MS, ROUND_MS } from "../../src/domain/config";

afterEach(async () => {
  await db.delete(paymentOffers);
  await db.delete(bids);
  await db.delete(bans);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

async function seedRoundWithOffer(startsAt: Date, bidAmount: number) {
  const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: startsAt }).returning();
  const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt, phase: "bidding" }).returning();
  const [bid] = await db
    .insert(bids)
    .values({ roundId: round.id, bidderId: "a", amountCents: bidAmount, depositCents: 1_000, depositRef: "d1", placedAt: new Date(startsAt.getTime() + 1000) })
    .returning();
  const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);
  await resolveBiddingPhaseSnapshot(round.id, snapshotAt);
  const [offer] = await db.select().from(paymentOffers).where(eq(paymentOffers.roundId, round.id));
  return { reignId: reign.id, roundId: round.id, bid, offer, snapshotAt };
}

describe("confirmPayment", () => {
  it("installs the payer as the new champion and marks the offer paid", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, bid, offer } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    const now = new Date(offer.offeredAt.getTime() + 1000);

    const result = await confirmPayment(offer.id, now, provider);
    expect(result.outcome).toBe("paid");

    const [updatedOffer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, offer.id));
    expect(updatedOffer.status).toBe("paid");

    const [updatedRound] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(updatedRound.phase).toBe("closed");

    expect(provider.remainderCharges.some((c) => c.bidderId === bid.bidderId)).toBe(true);
  });

  it("refunds every other bid in the round on payment", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offer } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(bids).values({
      roundId, bidderId: "loser", amountCents: 10_500, depositCents: 1_050, depositRef: "loser-dep", placedAt: new Date(startsAt.getTime() + 500),
    });
    const provider = new FakePaymentProvider();
    await confirmPayment(offer.id, new Date(offer.offeredAt.getTime() + 1000), provider);
    expect(provider.refunds).toContain("loser-dep");
  });

  it("a second concurrent call for the same offer is a safe no-op — never double-charges", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { offer } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    const now = new Date(offer.offeredAt.getTime() + 1000);

    const [first, second] = await Promise.all([
      confirmPayment(offer.id, now, provider),
      confirmPayment(offer.id, now, provider),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["already-processed", "paid"]);
    expect(provider.remainderCharges).toHaveLength(1);
  });
});

describe("resolveExpiredOffer", () => {
  it("forfeits the deposit, bans the bidder, and cascades to the next-highest bid", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offer, snapshotAt } = await seedRoundWithOffer(startsAt, 11_000);
    await db.insert(bids).values({
      roundId, bidderId: "second-in-line", amountCents: 10_500, depositCents: 1_050, depositRef: "second-dep", placedAt: new Date(startsAt.getTime() + 500),
    });
    const provider = new FakePaymentProvider();
    const expiry = new Date(Math.min(snapshotAt.getTime() + PAYMENT_ATTEMPT_MS, startsAt.getTime() + ROUND_MS));

    const result = await resolveExpiredOffer(offer.id, expiry, provider);
    expect(result.outcome).toBe("cascaded");

    const [firstBid] = await db.select().from(bids).where(eq(bids.bidderId, "a"));
    expect(firstBid.depositStatus).toBe("forfeited");
    expect(provider.refunds).not.toContain("d1");

    const [ban] = await db.select().from(bans).where(eq(bans.bidderId, "a"));
    expect(ban).toBeDefined();

    const [newOffer] = await db.select().from(paymentOffers).where(eq(paymentOffers.status, "pending"));
    expect(newOffer.bidId).not.toBe(offer.bidId);
  });

  it("closes the round and refunds the rest when the shared budget runs out", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, offer } = await seedRoundWithOffer(startsAt, 11_000);
    const provider = new FakePaymentProvider();
    const roundBoundary = new Date(startsAt.getTime() + ROUND_MS);

    const result = await resolveExpiredOffer(offer.id, roundBoundary, provider);
    expect(result.outcome).toBe("round-closed");

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("closed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/roundResolution.payment.test.ts`
Expected: FAIL — `confirmPayment` / `resolveExpiredOffer` not exported.

- [ ] **Step 3: Append to `src/engine/roundResolution.ts`**

Replace the file's import block (the top of `src/engine/roundResolution.ts`) with:

```ts
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { rounds, paymentOffers, bids, bans } from "../db/schema";
import { getQueueLeader } from "../db/repository";
import { installChampion } from "./installChampion";
import { PAYMENT_ATTEMPT_MS, ROUND_MS, BAN_DURATION_MS } from "../domain/config";
import type { PaymentProvider } from "../payments/PaymentProvider";
```

Add at the bottom of the file, after `resolveBiddingPhaseSnapshot`:

```ts
export async function confirmPayment(
  offerId: string,
  now: Date,
  provider: PaymentProvider,
  onInstalled?: (occupantId: string) => void,
): Promise<{ outcome: "paid" | "already-processed" }> {
  // Claim-before-charge: this single conditional UPDATE is what makes concurrent
  // duplicate calls safe. Postgres row-level locking means a second concurrent
  // UPDATE targeting the same row blocks until the first commits, then re-evaluates
  // `status = 'pending'` against the now-"processing" row and affects 0 rows — no
  // SERIALIZABLE isolation or retry loop needed for this pattern, unlike the
  // select-then-insert races in placeBidAtomic/createInitialReign/installChampion.
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

  const remainderCents = bid.amountCents - bid.depositCents;
  const paid = await provider.chargeRemainder(bid.bidderId, remainderCents, bid.depositRef);
  if (!paid) {
    // Release the claim so a legitimate future attempt (or the scheduled expiry
    // cascade) can still process this offer — do not leave it stuck in "processing".
    await db.update(paymentOffers).set({ status: "pending" }).where(eq(paymentOffers.id, offerId));
    throw new Error("chargeRemainder returned false inside confirmPayment — caller should not confirm an unsuccessful charge.");
  }

  await db.update(paymentOffers).set({ status: "paid" }).where(eq(paymentOffers.id, offerId));
  await db.update(rounds).set({ phase: "closed" }).where(eq(rounds.id, offer.roundId));
  await db.update(bids).set({ depositStatus: "refunded" }).where(eq(bids.id, bid.id));

  const otherBids = await db.select().from(bids).where(eq(bids.roundId, offer.roundId));
  for (const other of otherBids) {
    if (other.id === bid.id) continue;
    await provider.refund(other.depositRef);
    await db.update(bids).set({ depositStatus: "refunded" }).where(eq(bids.id, other.id));
  }

  await installChampion(bid.bidderId, bid.amountCents, now, onInstalled);

  return { outcome: "paid" };
}

export async function resolveExpiredOffer(
  offerId: string,
  now: Date,
  provider: PaymentProvider,
): Promise<{ outcome: "cascaded" | "round-closed" }> {
  const [offer] = await db.select().from(paymentOffers).where(eq(paymentOffers.id, offerId)).limit(1);
  if (!offer) throw new Error("Payment offer not found.");

  const [round] = await db.select().from(rounds).where(eq(rounds.id, offer.roundId)).limit(1);
  if (!round) throw new Error("Round not found.");

  const [failedBid] = await db.select().from(bids).where(eq(bids.id, offer.bidId)).limit(1);

  await db.update(paymentOffers).set({ status: "expired" }).where(eq(paymentOffers.id, offerId));
  await db.update(bids).set({ depositStatus: "forfeited" }).where(eq(bids.id, offer.bidId));
  await db.insert(bans).values({ bidderId: failedBid.bidderId, bannedUntil: new Date(now.getTime() + BAN_DURATION_MS) });

  const roundBoundary = new Date(round.startsAt.getTime() + ROUND_MS);
  if (now.getTime() >= roundBoundary.getTime()) {
    return closeRoundAndRefundRemaining(round.id, offer.bidId, provider, "round-closed");
  }

  const remainingBids = await db
    .select()
    .from(bids)
    .where(eq(bids.roundId, offer.roundId));
  const nextCandidates = remainingBids.filter((b) => b.id !== offer.bidId && b.depositStatus === "held");
  nextCandidates.sort((a, b) => b.amountCents - a.amountCents || a.placedAt.getTime() - b.placedAt.getTime());
  const next = nextCandidates[0];

  if (!next) {
    return closeRoundAndRefundRemaining(round.id, offer.bidId, provider, "round-closed");
  }

  const attemptExpiry = new Date(now.getTime() + PAYMENT_ATTEMPT_MS);
  const expiresAt = attemptExpiry.getTime() < roundBoundary.getTime() ? attemptExpiry : roundBoundary;

  await db.insert(paymentOffers).values({
    roundId: round.id,
    bidId: next.id,
    offeredAt: now,
    expiresAt,
    status: "pending",
  });

  return { outcome: "cascaded" };
}

async function closeRoundAndRefundRemaining(
  roundId: string,
  excludeBidId: string,
  provider: PaymentProvider,
  outcome: "round-closed",
): Promise<{ outcome: "round-closed" }> {
  await db.update(rounds).set({ phase: "closed" }).where(eq(rounds.id, roundId));

  const remaining = await db.select().from(bids).where(eq(bids.roundId, roundId));
  for (const b of remaining) {
    if (b.id === excludeBidId || b.depositStatus !== "held") continue;
    await provider.refund(b.depositRef);
    await db.update(bids).set({ depositStatus: "refunded" }).where(eq(bids.id, b.id));
  }

  return { outcome };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/roundResolution.payment.test.ts`
Expected: PASS — 5 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/engine/roundResolution.ts tests/engine/roundResolution.payment.test.ts
git commit -m "feat: add payment confirmation, cascade, and round exhaustion"
```

---

### Task 13: Scheduler tick — end-to-end multi-round reign

**Files:**
- Create: `src/engine/scheduler.ts`
- Test: `tests/engine/scheduler.test.ts`
- Modify: `src/db/schema.ts` (one enum value — see Step 0)
- Modify: `src/engine/roundResolution.ts` (harden `resolveBiddingPhaseSnapshot` — see Step 0)

**Interfaces:**
- Consumes: `resolveBiddingPhaseSnapshot`, `resolveExpiredOffer` (Task 10/12), `db`, `rounds`/`paymentOffers` tables, `installChampion` (used indirectly via `confirmPayment`), `BIDDING_PHASE_MS`/`ROUND_MS` (Task 2).
- Produces: `tick(now: Date, provider: PaymentProvider): Promise<void>` — finds every round whose bidding-phase snapshot is due and not yet taken, and every pending payment offer whose `expiresAt` has passed, and resolves them. Also: when a round closes empty (`resolveBiddingPhaseSnapshot` outcome `"empty-closed"`) or exhausts its cascade (`resolveExpiredOffer` outcome `"round-closed"`), `tick` creates the next day's round for the same reign (`startsAt = round.startsAt + ROUND_MS`, `phase: "bidding"`) — this is the "wait for next day" behavior from the spec, previously left to the caller.
- `resolveBiddingPhaseSnapshot`'s return type widens to `Promise<{ outcome: "empty-closed" | "offer-created" | "already-resolving" }>` (see Step 0).

**Money-safety note (why `resolveBiddingPhaseSnapshot` needs a claim guard before this task, not after):** Tasks 10 and 12's reviews both flagged that nothing prevents `resolveBiddingPhaseSnapshot` from running twice concurrently for the same round — e.g. two overlapping scheduler ticks (a slow tick still running when the next one fires, or two worker instances). Without a guard, both ticks would see `phase = "bidding"`, both call the function, and both would create a **separate** `paymentOffers` row for the same round (or worse, one could close a round the other is about to create an offer for). Confirming and cascade already claim atomically (Task 12); this closes the matching gap on the round-resolution side, using the identical pattern:

- [ ] **Step 0: Add a `"resolving"` transient phase and a claim guard**

In `src/db/schema.ts`, change:

```ts
export const roundPhaseEnum = pgEnum("round_phase", ["bidding", "payment", "closed"]);
```

to:

```ts
export const roundPhaseEnum = pgEnum("round_phase", ["bidding", "resolving", "payment", "closed"]);
```

Push the schema: `npm run db:push`. Run `npx vitest run tests/db/schema.test.ts` — must still pass unmodified.

In `src/engine/roundResolution.ts`, modify `resolveBiddingPhaseSnapshot` (from Task 10) to claim the round before touching anything else:

```ts
export async function resolveBiddingPhaseSnapshot(
  roundId: string,
  now: Date,
): Promise<{ outcome: "empty-closed" | "offer-created" | "already-resolving" }> {
  const claimed = await db
    .update(rounds)
    .set({ phase: "resolving" })
    .where(and(eq(rounds.id, roundId), eq(rounds.phase, "bidding")))
    .returning();

  if (claimed.length === 0) {
    return { outcome: "already-resolving" };
  }
  const round = claimed[0];

  const leader = await getQueueLeader(roundId);

  if (!leader) {
    await db.update(rounds).set({ phase: "closed" }).where(eq(rounds.id, roundId));
    return { outcome: "empty-closed" };
  }
```

(The rest of the function — computing `expiresAt`, inserting the `paymentOffers` row, and setting `phase: "payment"` — is unchanged from Task 10; only the top of the function and the return type change. You'll need `and` added to the `drizzle-orm` import in this file if it isn't already there from Task 12's changes.)

Update the two existing tests in `tests/engine/roundResolution.snapshot.test.ts` (Task 10) if their `seedRound` helper or assertions need adjustment for the new claim step — they shouldn't, since the function's external behavior (final phase, offer creation) is unchanged; only add a new test here:

```ts
it("a second concurrent call for the same round is a safe no-op — never creates two payment offers", async () => {
  const startsAt = new Date(2026, 0, 1, 0, 0, 0);
  const { roundId } = await seedRound(startsAt);
  await db.insert(bids).values({
    roundId, bidderId: "a", amountCents: 11_000, depositCents: 1_100, depositRef: "d1", placedAt: new Date(startsAt.getTime() + 1000),
  });
  const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);

  const [first, second] = await Promise.all([
    resolveBiddingPhaseSnapshot(roundId, snapshotAt),
    resolveBiddingPhaseSnapshot(roundId, snapshotAt),
  ]);

  const outcomes = [first.outcome, second.outcome].sort();
  expect(outcomes).toEqual(["already-resolving", "offer-created"]);

  const offers = await db.select().from(paymentOffers).where(eq(paymentOffers.roundId, roundId));
  expect(offers).toHaveLength(1);
});
```

Run `npx vitest run tests/engine/roundResolution.snapshot.test.ts` — must pass (3 tests now). Then run the full suite once to confirm nothing else broke (Task 7's `placeBidAtomic` phase check compares `!== "bidding"`, which still correctly rejects bids during the new `"resolving"` state — no change needed there).

Commit this as its own small commit (e.g. `fix: add claim guard to resolveBiddingPhaseSnapshot to prevent duplicate payment offers`) before moving on to Step 1 below.

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine/scheduler.test.ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans, paymentOffers } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { placeBid } from "../../src/engine/placeBid";
import { tick } from "../../src/engine/scheduler";
import { getCurrentReign, getLatestRound } from "../../src/db/repository";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";
import { BIDDING_PHASE_MS, ROUND_MS } from "../../src/domain/config";
import { eq } from "drizzle-orm";

afterEach(async () => {
  await db.delete(paymentOffers);
  await db.delete(bids);
  await db.delete(bans);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

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

  it("carries a reign across multiple rounds until someone pays", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    await createInitialReign("champ", startsAt);
    const provider = new FakePaymentProvider();

    // Day 1: nobody bids.
    await tick(new Date(startsAt.getTime() + ROUND_MS - 1000), provider);

    // Day 2: a challenger bids, then pays.
    const day2Start = new Date(startsAt.getTime() + ROUND_MS);
    const bidResult = await placeBid({ bidderId: "winner", amountCents: 11_000, now: new Date(day2Start.getTime() + 1000) }, provider);
    expect(bidResult.ok).toBe(true);

    const snapshotTime = new Date(day2Start.getTime() + BIDDING_PHASE_MS + 1000);
    await tick(snapshotTime, provider);

    const [offer] = await db.select().from(paymentOffers).where(eq(paymentOffers.status, "pending"));
    expect(offer).toBeDefined();

    const current = await getCurrentReign();
    expect(current?.occupantId).toBe("champ"); // not yet paid

    // Payment never confirmed; let it expire and cascade/close.
    await tick(new Date(offer.expiresAt.getTime() + 1000), provider);

    const afterExpiry = await getCurrentReign();
    expect(afterExpiry?.occupantId).toBe("champ"); // still champ, queue was exhausted after the one bidder
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/scheduler.test.ts`
Expected: FAIL — cannot find module `../../src/engine/scheduler`.

- [ ] **Step 3: Write `src/engine/scheduler.ts`**

```ts
import { and, eq, lte, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { reigns, rounds, paymentOffers } from "../db/schema";
import { resolveBiddingPhaseSnapshot, resolveExpiredOffer } from "./roundResolution";
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

    const result = await resolveBiddingPhaseSnapshot(round.id, snapshotAt);
    if (result.outcome === "empty-closed") {
      await startNextRound(round.reignId, round.startsAt);
    }
  }

  const duePendingOffers = await db
    .select()
    .from(paymentOffers)
    .where(and(eq(paymentOffers.status, "pending"), lte(paymentOffers.expiresAt, now)));

  for (const offer of duePendingOffers) {
    const [round] = await db.select().from(rounds).where(eq(rounds.id, offer.roundId)).limit(1);
    const result = await resolveExpiredOffer(offer.id, offer.expiresAt, provider);
    if (result.outcome === "round-closed") {
      await startNextRound(round.reignId, round.startsAt);
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/scheduler.test.ts`
Expected: PASS — 2 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/engine/scheduler.ts tests/engine/scheduler.test.ts
git commit -m "feat: add scheduler tick driving round-to-round progression"
```

---

### Task 14: Public read queries — scene and leaderboard

**Files:**
- Create: `src/queries/publicScene.ts`
- Test: `tests/queries/publicScene.test.ts`

**Interfaces:**
- Consumes: `db`, `reigns` table, `getCurrentReign` (Task 6).
- Produces:
  - `getScene(now: Date): Promise<{ champion: { occupantId: string; priceCents: number; since: Date } | null; retinue: { occupantId: string; priceCents: number; startedAt: Date; endedAt: Date }[] }>` — retinue is the last 8 ended reigns ordered most-recent-first, matching the prototype's `PEOPLE` / "Retinue #1..#8" ordering.
  - `getLeaderboard(): Promise<{ occupantId: string; rounds: number; totalSpentCents: number; totalDurationMs: number }[]>` — aggregated over every ended reign, grouped by `occupantId`, ordered by `totalDurationMs` descending, matching the prototype's `BOARD` shape.

- [ ] **Step 1: Write the failing test**

```ts
// tests/queries/publicScene.test.ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns } from "../../src/db/schema";
import { getScene, getLeaderboard } from "../../src/queries/publicScene";

afterEach(async () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/queries/publicScene.test.ts`
Expected: FAIL — cannot find module `../../src/queries/publicScene`.

- [ ] **Step 3: Write `src/queries/publicScene.ts`**

```ts
import { desc, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { reigns } from "../db/schema";

export async function getScene(_now: Date) {
  const [champion] = await db.select().from(reigns).where(isNull(reigns.endedAt)).limit(1);

  const retinueRows = await db
    .select()
    .from(reigns)
    .where(isNotNull(reigns.endedAt))
    .orderBy(desc(reigns.endedAt))
    .limit(8);

  return {
    champion: champion ? { occupantId: champion.occupantId, priceCents: champion.priceCents, since: champion.startedAt } : null,
    retinue: retinueRows.map((r) => ({
      occupantId: r.occupantId,
      priceCents: r.priceCents,
      startedAt: r.startedAt,
      endedAt: r.endedAt!,
    })),
  };
}

export async function getLeaderboard() {
  const ended = await db.select().from(reigns).where(isNotNull(reigns.endedAt));

  const byOccupant = new Map<string, { rounds: number; totalSpentCents: number; totalDurationMs: number }>();
  for (const r of ended) {
    const entry = byOccupant.get(r.occupantId) ?? { rounds: 0, totalSpentCents: 0, totalDurationMs: 0 };
    entry.rounds += 1;
    entry.totalSpentCents += r.priceCents;
    entry.totalDurationMs += r.endedAt!.getTime() - r.startedAt.getTime();
    byOccupant.set(r.occupantId, entry);
  }

  return [...byOccupant.entries()]
    .map(([occupantId, stats]) => ({ occupantId, ...stats }))
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/queries/publicScene.test.ts`
Expected: PASS — 3 tests passed.

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, all tests across every task pass together.

- [ ] **Step 6: Commit**

```bash
git add src/queries tests/queries
git commit -m "feat: add public scene and leaderboard read queries"
```

---

## Self-Review Notes

- **Spec coverage:** bidding-phase queue + min increment (Tasks 3, 7), 24h round split 12h/12h (Tasks 10, 12, 13), snapshot-by-timer (Task 10), shared 12h cascade budget with per-attempt 1h cap (Task 12), deposit 10%/$1000 cap (Task 2), refunds only after round resolution (Task 12), 3-round ban enforced at bid placement (Tasks 9, 12), first-bootstrap fixed price (Task 8), `PaymentProvider` boundary + `on_champion_installed` interface point (Tasks 5, 11), concurrent-bid race (Task 7), retinue-of-8 and leaderboard read model (Task 14) — all covered.
- **Deferred to later plans, intentionally:** real `PaymentProvider` implementations (YooKassa/Stripe), OAuth, the actual HTTP API surface exposing these use cases, wiring `tick` to a real cron/scheduler process, and the static page generation described in [public-page-delivery-design.md](../specs/2026-08-06-public-page-delivery-design.md).
- **Amended during execution (Task 11 review):** `confirmPayment` (Task 12) gained a claim-before-charge guard (`"processing"` offer status + conditional `UPDATE ... WHERE status = 'pending'`) after Task 11's implementer identified that a duplicate "Pay" submission would otherwise double-charge the bidder — a DB transaction can't fix this since the external payment charge itself isn't rollback-able. Known residual gap, explicitly out of scope for this plan: if `chargeRemainder` never resolves (hangs indefinitely, no provider-level timeout), the offer stays stuck in `"processing"` with no automatic recovery. A real `PaymentProvider` implementation should enforce its own call timeout; nothing in this domain layer currently does.
