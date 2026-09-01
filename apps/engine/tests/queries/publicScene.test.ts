import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns } from "../../src/db/schema";
import { getScene, getLeaderboard } from "../../src/queries/publicScene";

afterEach(async () => {
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

describe("getScene", () => {
  it("returns null champion and empty retinue with no reigns", async () => {
    const scene = await getScene(new Date());
    expect(scene.champion).toBeNull();
    expect(scene.retinue).toEqual([]);
  });

  it("returns the current champion and the last 8 ended reigns, most recent first", async () => {
    const base = new Date(2026, 0, 1);
    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 9; i++) {
      await db.insert(reigns).values({
        occupantId: `past-${i}`,
        priceCents: 10_000 + i,
        startedAt: new Date(base.getTime() + i * day),
        endedAt: new Date(base.getTime() + (i + 1) * day),
      });
    }
    await db.insert(reigns).values({ occupantId: "current", priceCents: 99_000, startedAt: new Date(base.getTime() + 9 * day) });

    const scene = await getScene(new Date(base.getTime() + 10 * day));
    expect(scene.champion?.occupantId).toBe("current");
    expect(scene.retinue).toHaveLength(8);
    expect(scene.retinue[0].occupantId).toBe("past-8"); // most recent ended reign first
    expect(scene.retinue[7].occupantId).toBe("past-1"); // 9th-oldest (past-0) dropped off
  });
});

describe("getLeaderboard", () => {
  it("aggregates rounds count, total spent, and total duration per occupant", async () => {
    const base = new Date(2026, 0, 1);
    const day = 24 * 60 * 60 * 1000;
    await db.insert(reigns).values([
      { occupantId: "alice", priceCents: 10_000, startedAt: base, endedAt: new Date(base.getTime() + day) },
      { occupantId: "alice", priceCents: 15_000, startedAt: new Date(base.getTime() + day), endedAt: new Date(base.getTime() + 3 * day) },
      { occupantId: "bob", priceCents: 20_000, startedAt: new Date(base.getTime() + 3 * day), endedAt: new Date(base.getTime() + 4 * day) },
    ]);

    const board = await getLeaderboard();
    const alice = board.find((r) => r.occupantId === "alice");
    expect(alice?.rounds).toBe(2);
    expect(alice?.totalSpentCents).toBe(25_000);
    expect(alice?.totalDurationMs).toBe(3 * day);

    expect(board[0].occupantId).toBe("alice"); // longer cumulative time than bob, ranked first
  });
});
