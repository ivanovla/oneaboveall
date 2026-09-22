import { describe, it, expect, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans, roundParticipants } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { placeBid } from "../../src/engine/placeBid";
import { getLatestRound } from "../../src/db/repository";
import { BIDDING_PHASE_MS, MAX_BID_CENTS } from "../../src/domain/config";

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

async function join(roundId: string, bidderId: string) {
  await db.insert(roundParticipants).values({ roundId, bidderId, depositCents: 1_000, depositRef: `pi_${bidderId}`, paymentMethodRef: `pm_${bidderId}` });
}

async function currentRoundId(reignId: string): Promise<string> {
  const round = await getLatestRound(reignId);
  return round!.id;
}

describe("placeBid", () => {
  it("records the bid for a bidder who already joined the round", async () => {
    const reign = await createInitialReign("champ", new Date(2026, 0, 1));
    await join(await currentRoundId(reign.id), "challenger");

    const result = await placeBid({ bidderId: "challenger", amountCents: 10_100, now: new Date(2026, 0, 1, 1) });
    expect(result.ok).toBe(true);
  });

  it("rejects a bid from a bidder who has not joined the round", async () => {
    await createInitialReign("champ", new Date(2026, 0, 1));
    const result = await placeBid({ bidderId: "challenger", amountCents: 10_100, now: new Date(2026, 0, 1, 1) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("Join this round");
  });

  it("rejects a bid below the minimum increment", async () => {
    const reign = await createInitialReign("champ", new Date(2026, 0, 1));
    await join(await currentRoundId(reign.id), "challenger");
    const result = await placeBid({ bidderId: "challenger", amountCents: 10_050, now: new Date(2026, 0, 1, 1) });
    expect(result.ok).toBe(false);
  });

  it("rejects a bid from a banned bidder", async () => {
    const reign = await createInitialReign("champ", new Date(2026, 0, 1));
    await join(await currentRoundId(reign.id), "challenger");
    await db.insert(bans).values({ bidderId: "challenger", bannedUntil: new Date(2026, 0, 10) });
    const result = await placeBid({ bidderId: "challenger", amountCents: 20_000, now: new Date(2026, 0, 1, 1) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("banned");
  });

  it("rejects a bid before the round's startsAt has arrived", async () => {
    const reign = await createInitialReign("champ", new Date(2026, 0, 1));
    const futureStartsAt = new Date(2026, 0, 2, 0, 0, 0);
    const [futureRound] = await db.insert(rounds).values({ reignId: reign.id, startsAt: futureStartsAt, phase: "bidding" }).returning();
    await join(futureRound.id, "challenger");

    const result = await placeBid({ bidderId: "challenger", amountCents: 20_000, now: new Date(futureStartsAt.getTime() - 1000) });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("not accepting bids");
  });

  it("rejects a bid placed after the bidding window closed", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    await join(await currentRoundId(reign.id), "sniper");

    const result = await placeBid({
      bidderId: "sniper",
      amountCents: 20_000,
      now: new Date(startsAt.getTime() + BIDDING_PHASE_MS + 3 * 60 * 60 * 1000),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("not accepting bids");
    expect(await db.select().from(bids)).toHaveLength(0);
  });

  it("accepts a bid in the last millisecond of the window and rejects one exactly at the close", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    await join(roundId, "early");
    await join(roundId, "late");
    const closesAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);

    const justInside = await placeBid({ bidderId: "early", amountCents: 10_100, now: new Date(closesAt.getTime() - 1) });
    expect(justInside.ok).toBe(true);

    const atClose = await placeBid({ bidderId: "late", amountCents: 20_000, now: closesAt });
    expect(atClose.ok).toBe(false);
  });

  it("rejects a NaN amount", async () => {
    const reign = await createInitialReign("champ", new Date(2026, 0, 1));
    await join(await currentRoundId(reign.id), "challenger");

    const result = await placeBid({ bidderId: "challenger", amountCents: NaN, now: new Date(2026, 0, 1, 1) });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("whole number");
    expect(await db.select().from(bids)).toHaveLength(0);
  });

  it("rejects an amount above MAX_BID_CENTS", async () => {
    const reign = await createInitialReign("champ", new Date(2026, 0, 1));
    await join(await currentRoundId(reign.id), "challenger");

    const result = await placeBid({ bidderId: "challenger", amountCents: 3_000_000_000, now: new Date(2026, 0, 1, 1) });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain(String(MAX_BID_CENTS));
    expect(await db.select().from(bids)).toHaveLength(0);
  });

  it("allows a joined bidder to raise their own bid more than once, for free", async () => {
    const reign = await createInitialReign("champ", new Date(2026, 0, 1));
    await join(await currentRoundId(reign.id), "challenger");
    const now = new Date(2026, 0, 1, 1);

    const first = await placeBid({ bidderId: "challenger", amountCents: 10_100, now });
    expect(first.ok).toBe(true);
    const second = await placeBid({ bidderId: "challenger", amountCents: 10_300, now });
    expect(second.ok).toBe(true);
    expect(await db.select().from(bids)).toHaveLength(2);
  });

  it("only lets one of two joined bidders win a concurrent equal-tier bid", async () => {
    const reign = await createInitialReign("champ", new Date(2026, 0, 1));
    const roundId = await currentRoundId(reign.id);
    await join(roundId, "a");
    await join(roundId, "b");
    const now = new Date(2026, 0, 1, 1);

    await Promise.all([db.execute(sql`select 1`), db.execute(sql`select 1`)]);

    const [a, b] = await Promise.all([
      placeBid({ bidderId: "a", amountCents: 10_100, now }),
      placeBid({ bidderId: "b", amountCents: 10_100, now }),
    ]);

    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
  });
});
