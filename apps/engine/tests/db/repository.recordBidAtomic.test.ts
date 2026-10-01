import { describe, it, expect, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids } from "../../src/db/schema";
import { recordBidAtomic } from "../../src/db/repository";
import { nextDailyCloseAt } from "../../src/domain/dailyClose";

afterEach(async () => {
  await db.delete(bids);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

async function seedRound(priceCents: number, phase: "bidding" | "closed" = "bidding") {
  const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents, startedAt: new Date() }).returning();
  const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date(), phase }).returning();
  return round.id;
}

describe("recordBidAtomic", () => {
  it("records a valid first bid against the champion price", async () => {
    const roundId = await seedRound(10_000);
    const result = await recordBidAtomic({ roundId, bidderId: "a", amountCents: 10_100, paymentRef: "pi_1" });
    expect(result.outcome).toBe("recorded");
    if (result.outcome !== "recorded") throw new Error("expected recorded");
    expect(result.bid.amountCents).toBe(10_100);
    expect(result.displacedBid).toBeNull();
  });

  it("rejects a bid that doesn't beat the champion by the minimum increment", async () => {
    const roundId = await seedRound(10_000);
    const result = await recordBidAtomic({ roundId, bidderId: "a", amountCents: 10_050, paymentRef: "pi_1" });
    expect(result.outcome).toBe("rejected");
  });

  it("rejects a bid that doesn't beat the current queue leader", async () => {
    const roundId = await seedRound(10_000);
    await recordBidAtomic({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a" });
    const second = await recordBidAtomic({ roundId, bidderId: "b", amountCents: 11_050, paymentRef: "pi_b" });
    expect(second.outcome).toBe("rejected");
  });

  it("accepts a bid that beats the current queue leader and reports the displaced bid", async () => {
    const roundId = await seedRound(10_000);
    await recordBidAtomic({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a" });
    const second = await recordBidAtomic({ roundId, bidderId: "b", amountCents: 11_100, paymentRef: "pi_b" });
    expect(second.outcome).toBe("recorded");
    if (second.outcome !== "recorded") throw new Error("expected recorded");
    expect(second.displacedBid?.bidderId).toBe("a");
  });

  it("rejects a bidder trying to raise their own standing bid", async () => {
    const roundId = await seedRound(10_000);
    await recordBidAtomic({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a" });
    const second = await recordBidAtomic({ roundId, bidderId: "a", amountCents: 12_000, paymentRef: "pi_a2" });
    expect(second.outcome).toBe("rejected");
    if (second.outcome !== "rejected") throw new Error("expected rejected");
    expect(second.reason).toContain("already the current leader");
  });

  it("is idempotent on paymentRef — a redelivered event is a safe no-op, not a duplicate bid", async () => {
    const roundId = await seedRound(10_000);
    const first = await recordBidAtomic({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a" });
    expect(first.outcome).toBe("recorded");
    const redelivered = await recordBidAtomic({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a" });
    expect(redelivered.outcome).toBe("already-recorded");

    const rows = await db.select().from(bids);
    expect(rows).toHaveLength(1);
  });

  it("rejects a bid against a round that has moved past the bidding phase", async () => {
    const closedRoundId = await seedRound(10_000, "closed");
    const closedResult = await recordBidAtomic({ roundId: closedRoundId, bidderId: "a", amountCents: 10_100, paymentRef: "pi_1" });
    expect(closedResult.outcome).toBe("rejected");
  });

  it("only lets one of two simultaneous equal-tier bids win the leader slot, via a genuine SERIALIZABLE conflict", async () => {
    const roundId = await seedRound(10_000);
    // Pre-warm two pool connections in parallel first. Without this, the second
    // recordBidAtomic call below can pay a cold `pool.connect()` penalty that lets
    // the first transaction fully commit before the second even starts its first
    // SELECT — the two calls end up serialized by accident (no SQLSTATE 40001 ever
    // fires) rather than genuinely racing inside Postgres's SERIALIZABLE isolation.
    await Promise.all([db.execute(sql`select 1`), db.execute(sql`select 1`)]);

    let retryCount = 0;
    const onRetry = () => {
      retryCount += 1;
    };

    const [r1, r2] = await Promise.all([
      recordBidAtomic({ roundId, bidderId: "a", amountCents: 10_100, paymentRef: "pi_a", onRetry }),
      recordBidAtomic({ roundId, bidderId: "b", amountCents: 10_100, paymentRef: "pi_b", onRetry }),
    ]);
    const recordedCount = [r1, r2].filter((r) => r.outcome === "recorded").length;
    expect(recordedCount).toBe(1);
    expect(retryCount).toBeGreaterThanOrEqual(1);
  });

  // The phase stays "bidding" through the whole champion-processing gap
  // (until the scheduler finally resolves the round), so phase alone would
  // let a webhook that lands after 4pm ET displace the true winner.
  it("rejects a bid placed at or after the round's daily close even while the phase is still bidding", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: startsAt }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt, phase: "bidding" }).returning();
    const closeAt = nextDailyCloseAt(startsAt);

    const atClose = await recordBidAtomic({ roundId: round.id, bidderId: "a", amountCents: 11_000, paymentRef: "pi_1", placedAt: closeAt });
    expect(atClose.outcome).toBe("rejected");

    const justBefore = await recordBidAtomic({
      roundId: round.id,
      bidderId: "a",
      amountCents: 11_000,
      paymentRef: "pi_2",
      placedAt: new Date(closeAt.getTime() - 1),
    });
    expect(justBefore.outcome).toBe("recorded");
  });
});
