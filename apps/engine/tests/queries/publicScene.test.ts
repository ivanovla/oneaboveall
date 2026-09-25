import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, users } from "../../src/db/schema";
import { getScene, getLeaderboard, getCurrentRoundInfo } from "../../src/queries/publicScene";
import { createInitialReign } from "../../src/engine/bootstrap";
import { getLatestRound } from "../../src/db/repository";
import { BIDDING_PHASE_MS } from "../../src/domain/config";

afterEach(async () => {
  await db.delete(rounds);
  await db.delete(reigns);
  await db.delete(users);
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

  // occupantId is a signed-in user's `users.id` UUID. Without the join this
  // query would hand the public homepage a raw
  // "3f2b8c4e-9d01-4a7b-…" to print in the champion banner.
  it("resolves a real user's name for the champion and the retinue, never the raw UUID", async () => {
    const [champUser] = await db
      .insert(users)
      .values({ provider: "google", providerId: "g-1", email: "champ@example.com", name: "Mark Vilensky" })
      .returning();
    const [pastUser] = await db
      .insert(users)
      .values({ provider: "apple", providerId: "a-1", email: "past@example.com", name: "Daniel Crowe" })
      .returning();

    const base = new Date(2026, 0, 1);
    const day = 24 * 60 * 60 * 1000;
    await db.insert(reigns).values({
      occupantId: pastUser.id,
      priceCents: 398_000,
      startedAt: base,
      endedAt: new Date(base.getTime() + day),
    });
    await db.insert(reigns).values({
      occupantId: champUser.id,
      priceCents: 421_000,
      startedAt: new Date(base.getTime() + day),
    });

    const scene = await getScene(new Date(base.getTime() + 2 * day));

    expect(scene.champion?.occupantName).toBe("Mark Vilensky");
    expect(scene.champion?.occupantName).not.toBe(champUser.id);
    expect(scene.retinue[0].occupantName).toBe("Daniel Crowe");
    // The raw id is still carried for keying/linking; only the display name changed.
    expect(scene.champion?.occupantId).toBe(champUser.id);
  });

  it("resolves a real user's social link for the champion and the retinue, null when unset", async () => {
    const [champUser] = await db
      .insert(users)
      .values({ provider: "google", providerId: "g-social-1", email: "champ2@example.com", name: "Champ", socialUrl: "https://x.com/champ" })
      .returning();
    const [pastUser] = await db
      .insert(users)
      .values({ provider: "apple", providerId: "a-social-1", email: "past2@example.com", name: "Past" })
      .returning();

    const base = new Date(2026, 0, 1);
    const day = 24 * 60 * 60 * 1000;
    await db.insert(reigns).values({
      occupantId: pastUser.id,
      priceCents: 100_000,
      startedAt: base,
      endedAt: new Date(base.getTime() + day),
    });
    await db.insert(reigns).values({
      occupantId: champUser.id,
      priceCents: 200_000,
      startedAt: new Date(base.getTime() + day),
    });

    const scene = await getScene(new Date(base.getTime() + 2 * day));

    expect(scene.champion?.socialUrl).toBe("https://x.com/champ");
    expect(scene.retinue[0].socialUrl).toBeNull(); // pastUser never set one
  });

  // users.name is NOT NULL but not non-empty: Apple only ever sends a name in
  // the unsigned "user" blob on the very first authorization, and authApple.ts
  // stores "" when that blob is missing or unparseable. And plenty of
  // occupants (the bootstrap champion, fixtures) aren't users at all.
  it("falls back to the raw occupantId when the occupant has no user row or an empty name", async () => {
    const [nameless] = await db
      .insert(users)
      .values({ provider: "apple", providerId: "a-2", email: "n@example.com", name: "" })
      .returning();

    const base = new Date(2026, 0, 1);
    const day = 24 * 60 * 60 * 1000;
    await db.insert(reigns).values({
      occupantId: nameless.id,
      priceCents: 100_000,
      startedAt: base,
      endedAt: new Date(base.getTime() + day),
    });
    // A non-UUID occupant: this is the case that would make a
    // `occupant_id::uuid` cast raise "invalid input syntax for type uuid" and
    // fail the whole request instead of simply not matching.
    await db.insert(reigns).values({ occupantId: "bootstrap-champ", priceCents: 200_000, startedAt: new Date(base.getTime() + day) });

    const scene = await getScene(new Date(base.getTime() + 2 * day));

    expect(scene.champion?.occupantName).toBe("bootstrap-champ");
    expect(scene.retinue[0].occupantName).toBe(nameless.id);
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

  it("resolves a real user's name per row, never the raw UUID", async () => {
    const [user] = await db
      .insert(users)
      .values({ provider: "google", providerId: "g-2", email: "l@example.com", name: "Lena Ortiz" })
      .returning();

    const base = new Date(2026, 0, 1);
    const day = 24 * 60 * 60 * 1000;
    await db.insert(reigns).values([
      { occupantId: user.id, priceCents: 10_000, startedAt: base, endedAt: new Date(base.getTime() + day) },
      { occupantId: user.id, priceCents: 15_000, startedAt: new Date(base.getTime() + day), endedAt: new Date(base.getTime() + 2 * day) },
    ]);

    const board = await getLeaderboard();

    expect(board).toHaveLength(1); // both reigns aggregate onto the one occupant
    expect(board[0].occupantName).toBe("Lena Ortiz");
    expect(board[0].rounds).toBe(2);
  });
});

describe("getCurrentRoundInfo", () => {
  it("returns null when no reign exists", async () => {
    expect(await getCurrentRoundInfo(new Date())).toBeNull();
  });

  it("returns the round id, phase, and leader price for the current round", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const round = await getLatestRound(reign.id);

    const info = await getCurrentRoundInfo(new Date(startsAt.getTime() + 1000));
    expect(info).not.toBeNull();
    expect(info?.roundId).toBe(round!.id);
    expect(info?.phase).toBe("bidding");
    expect(info?.currentLeaderCents).toBe(reign.priceCents); // no bids yet — leader is the champion's price
    expect(info?.biddingClosesAt).toEqual(new Date(startsAt.getTime() + BIDDING_PHASE_MS));
  });
});
