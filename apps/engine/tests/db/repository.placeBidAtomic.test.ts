import { describe, it, expect, afterEach, afterAll } from "vitest";
import { sql, and, eq } from "drizzle-orm";
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
  await db.insert(roundParticipants).values({ roundId, bidderId, depositCents: 1_000, depositRef: `pi_${bidderId}`, paymentMethodRef: `pm_${bidderId}`, customerRef: `cus_${bidderId}` });
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

  it("rejects a bid from a participant whose deposit is no longer held", async () => {
    const roundId = await seedRound(10_000);
    await join(roundId, "a");
    await db
      .update(roundParticipants)
      .set({ depositStatus: "refunded" })
      .where(and(eq(roundParticipants.roundId, roundId), eq(roundParticipants.bidderId, "a")));
    const result = await placeBidAtomic({ roundId, bidderId: "a", amountCents: 10_100 });
    expect(result.ok).toBe(false);
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
