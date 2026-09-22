import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans, roundParticipants } from "../../src/db/schema";
import { getCurrentReign, getLatestRound, getQueueLeader, isBanned, getRoundParticipant } from "../../src/db/repository";

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
