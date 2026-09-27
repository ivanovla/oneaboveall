// tests/engine/scheduler.test.ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { tick } from "../../src/engine/scheduler";
import { getCurrentReign, getLatestRound } from "../../src/db/repository";
import { BIDDING_PHASE_MS, ROUND_MS, CHAMPION_PROCESSING_GAP_MS } from "../../src/domain/config";

afterEach(async () => {
  await db.delete(bids);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

async function currentRoundId(reignId: string): Promise<string> {
  const round = await getLatestRound(reignId);
  return round!.id;
}

describe("tick", () => {
  it("rolls an empty round straight into the next day's round", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);

    await tick(new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000));

    const round = await getLatestRound(reign.id);
    expect(round?.startsAt).toEqual(new Date(startsAt.getTime() + ROUND_MS));
    expect(round?.phase).toBe("bidding");
  });

  it("does not install a winning bid until the processing gap has elapsed", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    await db.insert(bids).values({ roundId, bidderId: "winner", amountCents: 11_000, paymentRef: "pi_winner", placedAt: new Date(startsAt.getTime() + 1000) });

    // Bidding has closed, but CHAMPION_PROCESSING_GAP_MS hasn't elapsed yet
    // — the outgoing champion must keep showing on the public scene while
    // the winner's artwork is prepared, so nothing should install here.
    let installedOccupantId: string | undefined;
    await tick(new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000), (occupantId) => {
      installedOccupantId = occupantId;
    });

    expect(installedOccupantId).toBeUndefined();
    const current = await getCurrentReign();
    expect(current?.occupantId).toBe("champ");
  });

  it("installs a winning bid once the processing gap has elapsed", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    await db.insert(bids).values({ roundId, bidderId: "winner", amountCents: 11_000, paymentRef: "pi_winner", placedAt: new Date(startsAt.getTime() + 1000) });

    const settlementAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS + CHAMPION_PROCESSING_GAP_MS + 1000);
    let installedOccupantId: string | undefined;
    await tick(settlementAt, (occupantId) => {
      installedOccupantId = occupantId;
    });

    expect(installedOccupantId).toBe("winner");
    const current = await getCurrentReign();
    expect(current?.occupantId).toBe("winner");

    // installChampion starts the new reign's round at the moment of
    // installation, not on the ideal-schedule grid — a win begins the
    // winner's round right away rather than waiting for the slot the old
    // round would otherwise have vacated.
    const nextRound = await getLatestRound(current!.id);
    expect(nextRound?.startsAt).toEqual(settlementAt);
    expect(nextRound?.phase).toBe("bidding");
  });

  it("survives an empty day, chaining into a new round for the same reign", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    await createInitialReign("champ", startsAt);

    // Day 1: nobody bids.
    await tick(new Date(startsAt.getTime() + ROUND_MS + 1000));

    const afterDay1 = await getCurrentReign();
    expect(afterDay1?.occupantId).toBe("champ");

    const day2Round = await getLatestRound(afterDay1!.id);
    expect(day2Round?.startsAt).toEqual(new Date(startsAt.getTime() + ROUND_MS));
    expect(day2Round?.phase).toBe("bidding");
  });

  it("ignores a bid placed after the bidding window closed when picking the snapshot leader", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);
    await db.insert(bids).values({ roundId, bidderId: "honest", amountCents: 11_000, paymentRef: "pi_honest", placedAt: new Date(startsAt.getTime() + 1000) });
    await db.insert(bids).values({ roundId, bidderId: "sniper", amountCents: 99_000, paymentRef: "pi_sniper", placedAt: new Date(snapshotAt.getTime() + 1000) });

    await tick(new Date(snapshotAt.getTime() + CHAMPION_PROCESSING_GAP_MS + 5000));

    const current = await getCurrentReign();
    expect(current?.occupantId).toBe("honest");
  });

  it("a round that isn't due yet is left untouched", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    await db.insert(bids).values({ roundId, bidderId: "bidder", amountCents: 11_000, paymentRef: "pi_bidder" });

    // Well before the bidding window closes.
    await tick(new Date(startsAt.getTime() + 1000));

    const current = await getCurrentReign();
    expect(current?.occupantId).toBe("champ");
    const round = await getLatestRound(current!.id);
    expect(round?.phase).toBe("bidding");
  });
});
