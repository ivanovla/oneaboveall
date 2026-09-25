import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans, roundParticipants } from "../../src/db/schema";
import { getCurrentReign, getLatestRound, getQueueLeader, getBidderTopBid, isBanned, getRoundParticipant, getBidderHistory } from "../../src/db/repository";

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
      { roundId: round.id, bidderId: "a", amountCents: 11_000, placedAt: new Date(2026, 0, 1, 10, 0, 1) },
      { roundId: round.id, bidderId: "b", amountCents: 12_000, placedAt: new Date(2026, 0, 1, 10, 0, 2) },
      { roundId: round.id, bidderId: "c", amountCents: 12_000, placedAt: new Date(2026, 0, 1, 10, 0, 0) },
    ]);
    const leader = await getQueueLeader(round.id);
    expect(leader?.bidderId).toBe("c"); // tied on amount with b, but placed earliest
  });

  it("excludes bids placed after asOf when asOf is given", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "u1", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();
    const windowClose = new Date(2026, 0, 1, 12, 0, 0);
    await db.insert(bids).values([
      { roundId: round.id, bidderId: "in-window", amountCents: 11_000, placedAt: new Date(windowClose.getTime() - 1000) },
      { roundId: round.id, bidderId: "late", amountCents: 99_000, placedAt: new Date(windowClose.getTime() + 1000) },
    ]);

    // Without asOf the late (higher) bid leads; with asOf it is invisible.
    expect((await getQueueLeader(round.id))?.bidderId).toBe("late");
    expect((await getQueueLeader(round.id, windowClose))?.bidderId).toBe("in-window");

    // A bid placed exactly at asOf is still inside the window.
    expect((await getQueueLeader(round.id, new Date(windowClose.getTime() + 1000)))?.bidderId).toBe("late");
  });
});

describe("getBidderTopBid", () => {
  it("returns null when this bidder never bid in the round", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "u1", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();
    await db.insert(bids).values({ roundId: round.id, bidderId: "someone-else", amountCents: 11_000, placedAt: new Date() });

    expect(await getBidderTopBid(round.id, "a")).toBeNull();
  });

  it("returns this bidder's own highest bid, ignoring other bidders' higher ones", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "u1", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();
    await db.insert(bids).values([
      { roundId: round.id, bidderId: "a", amountCents: 11_000, placedAt: new Date(2026, 0, 1, 10, 0, 0) },
      { roundId: round.id, bidderId: "a", amountCents: 13_000, placedAt: new Date(2026, 0, 1, 10, 0, 5) },
      { roundId: round.id, bidderId: "b", amountCents: 20_000, placedAt: new Date(2026, 0, 1, 10, 0, 1) },
    ]);

    const top = await getBidderTopBid(round.id, "a");
    expect(top?.amountCents).toBe(13_000);
  });
});

describe("getBidderHistory", () => {
  it("returns an empty list for a bidder who never joined anything", async () => {
    expect(await getBidderHistory("nobody")).toEqual([]);
  });

  it("includes this bidder's own deposit and bids, most recent round first", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: new Date(2026, 0, 1) }).returning();
    const [roundA] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date(2026, 0, 1) }).returning();
    const [roundB] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date(2026, 0, 2) }).returning();

    await db.insert(roundParticipants).values([
      { roundId: roundA.id, bidderId: "a", depositCents: 1_000, depositRef: "pi_a", paymentMethodRef: "pm_a", customerRef: "cus_a", depositStatus: "refunded", joinedAt: new Date(2026, 0, 1, 10) },
      { roundId: roundB.id, bidderId: "a", depositCents: 1_000, depositRef: "pi_b", paymentMethodRef: "pm_b", customerRef: "cus_b", depositStatus: "applied", joinedAt: new Date(2026, 0, 2, 10) },
    ]);
    await db.insert(bids).values([
      { roundId: roundA.id, bidderId: "a", amountCents: 11_000, placedAt: new Date(2026, 0, 1, 11) },
      { roundId: roundA.id, bidderId: "a", amountCents: 12_000, placedAt: new Date(2026, 0, 1, 12) },
      // A different bidder's bid in the same round must never leak into "a"'s history.
      { roundId: roundA.id, bidderId: "someone-else", amountCents: 13_000, placedAt: new Date(2026, 0, 1, 13) },
      { roundId: roundB.id, bidderId: "a", amountCents: 15_000, placedAt: new Date(2026, 0, 2, 11) },
    ]);

    const history = await getBidderHistory("a");

    expect(history).toHaveLength(2);
    // Most recently joined round first.
    expect(history[0]).toMatchObject({ roundId: roundB.id, depositCents: 1_000, depositStatus: "applied" });
    expect(history[0].bids).toEqual([{ amountCents: 15_000, placedAt: new Date(2026, 0, 2, 11) }]);
    expect(history[1]).toMatchObject({ roundId: roundA.id, depositCents: 1_000, depositStatus: "refunded" });
    // This bidder's own two bids, most recent first — the other bidder's
    // higher bid in the same round is excluded.
    expect(history[1].bids).toEqual([
      { amountCents: 12_000, placedAt: new Date(2026, 0, 1, 12) },
      { amountCents: 11_000, placedAt: new Date(2026, 0, 1, 11) },
    ]);
  });

  it("includes a round joined but never bid on, with an empty bids list", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();
    await db.insert(roundParticipants).values({ roundId: round.id, bidderId: "a", depositCents: 1_000, depositRef: "pi_a", paymentMethodRef: "pm_a", customerRef: "cus_a" });

    const history = await getBidderHistory("a");
    expect(history).toHaveLength(1);
    expect(history[0].bids).toEqual([]);
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

describe("getRoundParticipant", () => {
  it("returns null when the bidder hasn't joined this round", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "u1", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();
    expect(await getRoundParticipant(round.id, "nobody")).toBeNull();
  });

  it("returns the participant row once joined", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "u1", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();
    await db.insert(roundParticipants).values({ roundId: round.id, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", customerRef: "cus_1" });

    const participant = await getRoundParticipant(round.id, "a");
    expect(participant?.depositStatus).toBe("held");
    expect(participant?.depositCents).toBe(1_000);
  });
});
