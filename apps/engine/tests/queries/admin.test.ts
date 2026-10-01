import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { bids, refVisits, reigns, rounds, users } from "../../src/db/schema";
import { getAdminStats, getAdminRound } from "../../src/queries/admin";
import { createInitialReign } from "../../src/engine/bootstrap";
import { getLatestRound } from "../../src/db/repository";

afterEach(async () => {
  await db.delete(bids);
  await db.delete(rounds);
  await db.delete(reigns);
  await db.delete(refVisits);
  await db.delete(users);
});

afterAll(async () => {
  await pool.end();
});

async function user(providerId: string, extra: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await db
    .insert(users)
    .values({ provider: "google", providerId, email: `${providerId}@example.com`, name: providerId, ...extra })
    .returning();
  return row;
}

describe("getAdminStats", () => {
  it("reports visits, sign-ups, distinct bidders, winners and captured revenue per ref, plus totals", async () => {
    const startsAt = new Date(2026, 0, 1);
    const reign = await createInitialReign("champ", startsAt);
    const round = (await getLatestRound(reign.id))!;

    await db.insert(refVisits).values([{ ref: "bob", count: 10 }, { ref: "carol", count: 3 }]);
    const b1 = await user("b1", { ref: "bob" });
    const b2 = await user("b2", { ref: "bob" });
    await user("b3", { ref: "bob" }); // signed up, never bid
    const direct = await user("direct");

    const t = (m: number) => new Date(startsAt.getTime() + m * 60_000);
    await db.insert(bids).values([
      // b1 bid twice and won with the second bid.
      { roundId: round.id, bidderId: b1.id, amountCents: 110_000, paymentRef: "pi_s1", placedAt: t(1), refundedAt: t(2) },
      { roundId: round.id, bidderId: b1.id, amountCents: 130_000, paymentRef: "pi_s2", placedAt: t(3), capturedAt: t(9) },
      { roundId: round.id, bidderId: b2.id, amountCents: 120_000, paymentRef: "pi_s3", placedAt: t(2), refundedAt: t(9) },
      { roundId: round.id, bidderId: direct.id, amountCents: 125_000, paymentRef: "pi_s4", placedAt: t(2), refundedAt: t(9) },
    ]);

    const stats = await getAdminStats();
    expect(stats.refs).toEqual([
      { ref: "bob", visits: 10, signups: 3, bidders: 2, winners: 1, revenueCents: 130_000 },
      { ref: "carol", visits: 3, signups: 0, bidders: 0, winners: 0, revenueCents: 0 },
    ]);
    expect(stats.totals).toEqual({ visits: 13, signups: 4, bidders: 3, winners: 1, revenueCents: 130_000 });
  });
});

describe("getAdminRound", () => {
  it("returns null with no reign", async () => {
    expect(await getAdminRound()).toBeNull();
  });

  it("returns champion, leader and runner-up (a different bidder) with contact details", async () => {
    const startsAt = new Date(2026, 0, 1);
    const champ = await user("champ-u", { photoPath: "x.jpg", sponsored: true });
    const reign = await createInitialReign(champ.id, startsAt);
    const round = (await getLatestRound(reign.id))!;
    const alice = await user("alice", { socialUrl: "https://x.com/alice", characterRequest: "a knight" });
    const bob = await user("bob");

    const t = (m: number) => new Date(startsAt.getTime() + m * 60_000);
    await db.insert(bids).values([
      { roundId: round.id, bidderId: bob.id, amountCents: 110_000, paymentRef: "pi_r1", placedAt: t(1) },
      { roundId: round.id, bidderId: alice.id, amountCents: 120_000, paymentRef: "pi_r2", placedAt: t(2) },
      // Alice's own re-bid: the runner-up must still be Bob, not Alice's older hold.
      { roundId: round.id, bidderId: alice.id, amountCents: 130_000, paymentRef: "pi_r3", placedAt: t(3) },
      { roundId: round.id, bidderId: bob.id, amountCents: 140_000, paymentRef: "pi_r4", placedAt: t(0), refundedAt: t(1) },
    ]);

    const info = (await getAdminRound())!;
    expect(info.round?.id).toBe(round.id);
    expect(info.champion).toMatchObject({ userId: champ.id, email: "champ-u@example.com", hasPhoto: true, sponsored: true });
    expect(info.leader).toMatchObject({
      userId: alice.id,
      name: "alice",
      email: "alice@example.com",
      amountCents: 130_000,
      captured: false,
      hasPhoto: false,
      socialUrl: "https://x.com/alice",
      characterRequest: "a knight",
      sponsored: false,
    });
    expect(info.runnerUp).toMatchObject({ userId: bob.id, amountCents: 110_000 });
  });
});
