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
    // Pre-warm two pool connections in parallel first. Without this, the second
    // placeBidAtomic call below can pay a cold `pool.connect()` penalty that lets
    // the first transaction fully commit before the second even starts its first
    // SELECT — the two calls end up serialized by accident (no SQLSTATE 40001 ever
    // fires) rather than genuinely racing inside Postgres's SERIALIZABLE isolation.
    // Warming both connections first ensures the two transactions below actually
    // overlap, so this test exercises the real conflict-and-retry path.
    await Promise.all([db.execute(sql`select 1`), db.execute(sql`select 1`)]);

    const [r1, r2] = await Promise.all([
      placeBidAtomic({ roundId, bidderId: "a", amountCents: 10_100, depositCents: 1_010, depositRef: "d1" }),
      placeBidAtomic({ roundId, bidderId: "b", amountCents: 10_100, depositCents: 1_010, depositRef: "d2" }),
    ]);
    const okCount = [r1, r2].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
  });
});
