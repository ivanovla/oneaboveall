import { describe, it, expect, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
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

async function seedRound(priceCents: number, phase: "bidding" | "payment" | "closed" = "bidding") {
  const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents, startedAt: new Date() }).returning();
  const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date(), phase }).returning();
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

  it("rejects a bid against a round that has moved past the bidding phase", async () => {
    const paymentRoundId = await seedRound(10_000, "payment");
    const paymentResult = await placeBidAtomic({
      roundId: paymentRoundId,
      bidderId: "a",
      amountCents: 10_100,
      depositCents: 1_010,
      depositRef: "d1",
    });
    expect(paymentResult.ok).toBe(false);

    const closedRoundId = await seedRound(10_000, "closed");
    const closedResult = await placeBidAtomic({
      roundId: closedRoundId,
      bidderId: "a",
      amountCents: 10_100,
      depositCents: 1_010,
      depositRef: "d2",
    });
    expect(closedResult.ok).toBe(false);
  });

  it("only lets one of two simultaneous equal-tier bids win the leader slot, via a genuine SERIALIZABLE conflict", async () => {
    const roundId = await seedRound(10_000);
    // Pre-warm two pool connections in parallel first. Without this, the second
    // placeBidAtomic call below can pay a cold `pool.connect()` penalty that lets
    // the first transaction fully commit before the second even starts its first
    // SELECT — the two calls end up serialized by accident (no SQLSTATE 40001 ever
    // fires) rather than genuinely racing inside Postgres's SERIALIZABLE isolation.
    // Warming both connections first ensures the two transactions below actually
    // overlap, so this test exercises the real conflict-and-retry path.
    await Promise.all([db.execute(sql`select 1`), db.execute(sql`select 1`)]);

    // `okCount === 1` alone is satisfied both by a genuine SERIALIZABLE conflict
    // (one transaction aborted with 40001 and correctly retried-and-rejected) and
    // by the two calls running accidentally sequentially (no conflict at all,
    // second call just sees the first's committed row via ordinary validation).
    // Those two outcomes are indistinguishable from `okCount` alone, which is
    // exactly how the pre-warm fix above stayed silently unverified. To make the
    // mechanism itself assertable, count retries via `onRetry` — this only fires
    // when the loop catches SQLSTATE 40001 — and require at least one to have
    // happened. If someone drops `isolationLevel: "serializable"` or the pool
    // stops overlapping the two transactions, this assertion fails even though
    // `okCount` would still happen to be 1.
    let retryCount = 0;
    const onRetry = () => {
      retryCount += 1;
    };

    const [r1, r2] = await Promise.all([
      placeBidAtomic({ roundId, bidderId: "a", amountCents: 10_100, depositCents: 1_010, depositRef: "d1", onRetry }),
      placeBidAtomic({ roundId, bidderId: "b", amountCents: 10_100, depositCents: 1_010, depositRef: "d2", onRetry }),
    ]);
    const okCount = [r1, r2].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
    expect(retryCount).toBeGreaterThanOrEqual(1);
  });
});
