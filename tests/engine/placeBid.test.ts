import { describe, it, expect, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { placeBid } from "../../src/engine/placeBid";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";
import { BIDDING_PHASE_MS, MAX_BID_CENTS } from "../../src/domain/config";

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

  it("rejects a bid before the round's startsAt has arrived, without charging a deposit", async () => {
    const reign = await createInitialReign("champ", new Date(2026, 0, 1));
    // Simulate the scheduler having already opened tomorrow's round: phase
    // "bidding", but startsAt is still in the future.
    const futureStartsAt = new Date(2026, 0, 2, 0, 0, 0);
    await db.insert(rounds).values({ reignId: reign.id, startsAt: futureStartsAt, phase: "bidding" });

    const provider = new FakePaymentProvider();
    const result = await placeBid(
      { bidderId: "challenger", amountCents: 20_000, now: new Date(futureStartsAt.getTime() - 1000) },
      provider,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("not accepting bids");
    expect(provider.charges).toHaveLength(0);
  });

  it("rejects a bid placed after the bidding window closed, without charging a deposit", async () => {
    // The round keeps phase "bidding" from T0+12h until the scheduler's tick
    // snapshots it. A sniper waiting for the window to visibly close must not
    // be able to slip a bid into that gap and win the snapshot.
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    await createInitialReign("champ", startsAt);
    const provider = new FakePaymentProvider();

    const result = await placeBid(
      { bidderId: "sniper", amountCents: 20_000, now: new Date(startsAt.getTime() + BIDDING_PHASE_MS + 3 * 60 * 60 * 1000) },
      provider,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("not accepting bids");
    expect(provider.charges).toHaveLength(0);
    expect(await db.select().from(bids)).toHaveLength(0);
  });

  it("accepts a bid in the last millisecond of the window and rejects one exactly at the close", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    await createInitialReign("champ", startsAt);
    const provider = new FakePaymentProvider();
    const closesAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);

    const justInside = await placeBid(
      { bidderId: "early", amountCents: 10_100, now: new Date(closesAt.getTime() - 1) },
      provider,
    );
    expect(justInside.ok).toBe(true);

    const atClose = await placeBid({ bidderId: "late", amountCents: 20_000, now: closesAt }, provider);
    expect(atClose.ok).toBe(false);
    expect(provider.charges).toHaveLength(1); // only the accepted bid was charged
  });

  it("rejects a NaN amount before any deposit is charged", async () => {
    await createInitialReign("champ", new Date(2026, 0, 1));
    const provider = new FakePaymentProvider();

    const result = await placeBid({ bidderId: "challenger", amountCents: NaN, now: new Date(2026, 0, 1, 1) }, provider);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("whole number");
    expect(provider.charges).toHaveLength(0);
    expect(provider.refunds).toHaveLength(0);
    expect(await db.select().from(bids)).toHaveLength(0);
  });

  it("rejects an amount above MAX_BID_CENTS before any deposit is charged", async () => {
    // 3_000_000_000 exceeds Postgres int4 — reaching the insert would throw
    // 22003 with the deposit already charged and nothing to refund it.
    await createInitialReign("champ", new Date(2026, 0, 1));
    const provider = new FakePaymentProvider();

    const result = await placeBid({ bidderId: "challenger", amountCents: 3_000_000_000, now: new Date(2026, 0, 1, 1) }, provider);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain(String(MAX_BID_CENTS));
    expect(provider.charges).toHaveLength(0);
    expect(provider.refunds).toHaveLength(0);
    expect(await db.select().from(bids)).toHaveLength(0);
  });

  it("refunds the deposit when a concurrent bid wins the same slot", async () => {
    await createInitialReign("champ", new Date(2026, 0, 1));
    const provider = new FakePaymentProvider();
    const now = new Date(2026, 0, 1, 1);

    // Pre-warm two pool connections so the two placeBid calls below genuinely
    // overlap instead of running accidentally sequentially — same rationale as
    // the identical pre-warm in tests/db/repository.placeBidAtomic.test.ts.
    // Both calls' pre-checks read the same (empty) queue, pass validation, and
    // charge a deposit; only one wins the atomic insert, and the loser's
    // rejection must trigger a refund of its already-charged deposit.
    await Promise.all([db.execute(sql`select 1`), db.execute(sql`select 1`)]);

    const [a, b] = await Promise.all([
      placeBid({ bidderId: "a", amountCents: 10_100, now }, provider),
      placeBid({ bidderId: "b", amountCents: 10_100, now }, provider),
    ]);

    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(provider.charges).toHaveLength(2);
    expect(provider.refunds).toHaveLength(1);
  });
});
