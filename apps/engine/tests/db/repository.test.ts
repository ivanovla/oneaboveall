import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids } from "../../src/db/schema";
import { getCurrentReign, getLatestRound, getQueueLeader, getBidderTopBid, getBidderHistory } from "../../src/db/repository";

afterEach(async () => {
  await db.delete(bids);
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
      { roundId: round.id, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", placedAt: new Date(2026, 0, 1, 10, 0, 1) },
      { roundId: round.id, bidderId: "b", amountCents: 12_000, paymentRef: "pi_b", placedAt: new Date(2026, 0, 1, 10, 0, 2) },
      { roundId: round.id, bidderId: "c", amountCents: 12_000, paymentRef: "pi_c", placedAt: new Date(2026, 0, 1, 10, 0, 0) },
    ]);
    const leader = await getQueueLeader(round.id);
    expect(leader?.bidderId).toBe("c"); // tied on amount with b, but placed earliest
  });

  it("excludes bids placed after asOf when asOf is given", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "u1", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();
    const windowClose = new Date(2026, 0, 1, 12, 0, 0);
    await db.insert(bids).values([
      { roundId: round.id, bidderId: "in-window", amountCents: 11_000, paymentRef: "pi_1", placedAt: new Date(windowClose.getTime() - 1000) },
      { roundId: round.id, bidderId: "late", amountCents: 99_000, paymentRef: "pi_2", placedAt: new Date(windowClose.getTime() + 1000) },
    ]);

    // Without asOf the late (higher) bid leads; with asOf it is invisible.
    expect((await getQueueLeader(round.id))?.bidderId).toBe("late");
    expect((await getQueueLeader(round.id, windowClose))?.bidderId).toBe("in-window");

    // A bid placed exactly at asOf is still inside the window.
    expect((await getQueueLeader(round.id, new Date(windowClose.getTime() + 1000)))?.bidderId).toBe("late");
  });

  it("never returns a refunded (outbid) bid as the leader", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "u1", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();
    await db.insert(bids).values([
      { roundId: round.id, bidderId: "outbid", amountCents: 99_000, paymentRef: "pi_1", refundedAt: new Date() },
      { roundId: round.id, bidderId: "current", amountCents: 11_000, paymentRef: "pi_2" },
    ]);
    expect((await getQueueLeader(round.id))?.bidderId).toBe("current");
  });
});

describe("getBidderTopBid", () => {
  it("returns null when this bidder never bid in the round", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "u1", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();
    await db.insert(bids).values({ roundId: round.id, bidderId: "someone-else", amountCents: 11_000, paymentRef: "pi_1", placedAt: new Date() });

    expect(await getBidderTopBid(round.id, "a")).toBeNull();
  });

  it("returns this bidder's own highest bid, ignoring other bidders' higher ones", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "u1", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();
    await db.insert(bids).values([
      { roundId: round.id, bidderId: "a", amountCents: 11_000, paymentRef: "pi_1", placedAt: new Date(2026, 0, 1, 10, 0, 0) },
      { roundId: round.id, bidderId: "a", amountCents: 13_000, paymentRef: "pi_2", placedAt: new Date(2026, 0, 1, 10, 0, 5) },
      { roundId: round.id, bidderId: "b", amountCents: 20_000, paymentRef: "pi_3", placedAt: new Date(2026, 0, 1, 10, 0, 1) },
    ]);

    const top = await getBidderTopBid(round.id, "a");
    expect(top?.amountCents).toBe(13_000);
  });
});

describe("getBidderHistory", () => {
  it("returns an empty list for a bidder who never bid on anything", async () => {
    expect(await getBidderHistory("nobody")).toEqual([]);
  });

  it("includes this bidder's own bids, most recently bid-in round first, each carrying its own status", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: new Date(2026, 0, 1) }).returning();
    const [roundA] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date(2026, 0, 1), phase: "closed" }).returning();
    const [roundB] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date(2026, 0, 2), phase: "bidding" }).returning();

    await db.insert(bids).values([
      // Round A (closed): "a" was outbid, then bid again and won.
      { roundId: roundA.id, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a1", refundedAt: new Date(2026, 0, 1, 12), placedAt: new Date(2026, 0, 1, 11) },
      { roundId: roundA.id, bidderId: "a", amountCents: 13_000, paymentRef: "pi_a2", placedAt: new Date(2026, 0, 1, 13) },
      // A different bidder's bid in the same round must never leak into "a"'s history.
      { roundId: roundA.id, bidderId: "someone-else", amountCents: 12_000, paymentRef: "pi_x", refundedAt: new Date(2026, 0, 1, 13), placedAt: new Date(2026, 0, 1, 12) },
      // Round B (still bidding): "a" is currently leading.
      { roundId: roundB.id, bidderId: "a", amountCents: 15_000, paymentRef: "pi_b1", placedAt: new Date(2026, 0, 2, 11) },
    ]);

    const history = await getBidderHistory("a");

    expect(history).toHaveLength(2);
    // Most recently bid-in round first.
    expect(history[0].roundId).toBe(roundB.id);
    expect(history[0].bids).toEqual([{ amountCents: 15_000, placedAt: new Date(2026, 0, 2, 11), status: "active" }]);
    expect(history[1].roundId).toBe(roundA.id);
    // This bidder's own two bids, most recent first — the other bidder's bid
    // in the same round is excluded.
    expect(history[1].bids).toEqual([
      { amountCents: 13_000, placedAt: new Date(2026, 0, 1, 13), status: "won" },
      { amountCents: 11_000, placedAt: new Date(2026, 0, 1, 11), status: "refunded" },
    ]);
  });

  // The round stays "bidding" through the champion-processing gap, but once
  // settlement has captured a bid it has won — it must not keep reading as
  // "active" for those hours.
  it("reports a captured bid as won even while its round is still in the processing gap", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: new Date(2026, 0, 1) }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date(2026, 0, 1), phase: "bidding" }).returning();
    await db.insert(bids).values({ roundId: round.id, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", placedAt: new Date(2026, 0, 1, 11), capturedAt: new Date(2026, 0, 1, 16) });

    const history = await getBidderHistory("a");
    expect(history[0].bids[0].status).toBe("won");
  });
});
