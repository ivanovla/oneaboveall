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
