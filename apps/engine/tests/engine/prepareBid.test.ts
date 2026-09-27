import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { prepareBid, isBiddingOpen } from "../../src/engine/prepareBid";
import { getLatestRound } from "../../src/db/repository";
import { STARTING_PRICE_CENTS, MIN_INCREMENT_CENTS } from "../../src/domain/config";
import { nextDailyCloseAt } from "../../src/domain/dailyClose";

afterEach(async () => {
  await db.delete(bids);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

describe("isBiddingOpen", () => {
  it("is open from startsAt up to (not including) the next daily close", () => {
    const startsAt = new Date("2026-01-01T12:00:00.000Z");
    const round = { phase: "bidding", startsAt };
    const closesAt = nextDailyCloseAt(startsAt).getTime();
    expect(isBiddingOpen(round, startsAt)).toBe(true);
    expect(isBiddingOpen(round, new Date(closesAt - 1))).toBe(true);
    expect(isBiddingOpen(round, new Date(closesAt))).toBe(false);
    expect(isBiddingOpen(round, new Date(startsAt.getTime() - 1))).toBe(false);
  });

  it("is never open when the phase isn't 'bidding'", () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    expect(isBiddingOpen({ phase: "closed", startsAt }, startsAt)).toBe(false);
  });
});

describe("prepareBid", () => {
  it("rejects when no reign has been bootstrapped yet", async () => {
    const result = await prepareBid({ bidderId: "a", amountCents: 10_100, now: new Date() });
    expect(result.ok).toBe(false);
  });

  it("accepts a valid first bid against the champion price", async () => {
    const startsAt = new Date(2026, 0, 1);
    await createInitialReign("champ", startsAt);
    const result = await prepareBid({ bidderId: "a", amountCents: 10_100, now: new Date(startsAt.getTime() + 1000) });
    expect(result.ok).toBe(true);
  });

  it("rejects a bid that doesn't beat the champion by the minimum increment", async () => {
    const startsAt = new Date(2026, 0, 1);
    await createInitialReign("champ", startsAt);
    const belowMinimumIncrement = STARTING_PRICE_CENTS + MIN_INCREMENT_CENTS - 50;
    const result = await prepareBid({ bidderId: "a", amountCents: belowMinimumIncrement, now: new Date(startsAt.getTime() + 1000) });
    expect(result.ok).toBe(false);
  });

  it("rejects a bidder trying to raise their own standing bid", async () => {
    const startsAt = new Date(2026, 0, 1);
    const reign = await createInitialReign("champ", startsAt);
    const round = await getLatestRound(reign.id);
    await db.insert(bids).values({ roundId: round!.id, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a" });

    const result = await prepareBid({ bidderId: "a", amountCents: 12_000, now: new Date(startsAt.getTime() + 1000) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("already the current leader");
  });

  it("rejects a bid once the bidding window has closed", async () => {
    const startsAt = new Date(2026, 0, 1);
    await createInitialReign("champ", startsAt);
    const result = await prepareBid({ bidderId: "a", amountCents: 10_100, now: nextDailyCloseAt(startsAt) });
    expect(result.ok).toBe(false);
  });
});
