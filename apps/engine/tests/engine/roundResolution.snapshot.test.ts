import { describe, it, expect, afterEach, afterAll } from "vitest";
import { eq, isNull } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids } from "../../src/db/schema";
import { resolveBiddingPhaseSnapshot } from "../../src/engine/roundResolution";
import { BIDDING_PHASE_MS } from "../../src/domain/config";

afterEach(async () => {
  await db.delete(bids);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

async function seedRound(startsAt: Date) {
  const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: startsAt }).returning();
  const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt, phase: "bidding" }).returning();
  return { reignId: reign.id, roundId: round.id };
}

describe("resolveBiddingPhaseSnapshot", () => {
  it("closes the round with no change when the queue is empty", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);

    const result = await resolveBiddingPhaseSnapshot(roundId, snapshotAt);
    expect(result.outcome).toBe("empty-closed");

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("closed");
  });

  it("installs the snapshot leader as champion when the queue is non-empty", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId, reignId } = await seedRound(startsAt);
    await db.insert(bids).values({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", placedAt: new Date(startsAt.getTime() + 1000) });
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);

    let installedOccupantId: string | undefined;
    const result = await resolveBiddingPhaseSnapshot(roundId, snapshotAt, (occupantId) => {
      installedOccupantId = occupantId;
    });
    expect(result.outcome).toBe("installed");
    expect(installedOccupantId).toBe("a");

    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("closed");

    const [oldReign] = await db.select().from(reigns).where(eq(reigns.id, reignId));
    expect(oldReign.endedAt).not.toBeNull();

    const [newReign] = await db.select().from(reigns).where(isNull(reigns.endedAt));
    expect(newReign.occupantId).toBe("a");
    expect(newReign.priceCents).toBe(11_000);
  });

  it("a second concurrent call for the same round is a safe no-op — never installs a champion twice", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    await db.insert(bids).values({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", placedAt: new Date(startsAt.getTime() + 1000) });
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);

    const [first, second] = await Promise.all([
      resolveBiddingPhaseSnapshot(roundId, snapshotAt),
      resolveBiddingPhaseSnapshot(roundId, snapshotAt),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["already-resolving", "installed"]);

    const reignsAfter = await db.select().from(reigns).where(isNull(reigns.endedAt));
    expect(reignsAfter).toHaveLength(1);
  });

  it("ignores a bid placed after the bidding window closed when picking the snapshot leader", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const { roundId } = await seedRound(startsAt);
    const snapshotAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);
    await db.insert(bids).values({ roundId, bidderId: "honest", amountCents: 11_000, paymentRef: "pi_honest", placedAt: new Date(startsAt.getTime() + 1000) });
    await db.insert(bids).values({ roundId, bidderId: "sniper", amountCents: 99_000, paymentRef: "pi_sniper", placedAt: new Date(snapshotAt.getTime() + 1000) });

    const result = await resolveBiddingPhaseSnapshot(roundId, snapshotAt);
    expect(result.outcome).toBe("installed");

    const [newReign] = await db.select().from(reigns).where(isNull(reigns.endedAt));
    expect(newReign.occupantId).toBe("honest");
  });
});
