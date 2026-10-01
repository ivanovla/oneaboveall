import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids } from "../../src/db/schema";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";
import { FakeNotifier } from "../../src/notifications/FakeNotifier";

// Two concurrent deliveries of the same webhook can each run their own
// recordBidAtomic transaction against a snapshot that predates the other's
// commit. One records the bid; the other — landing a moment later, past the
// close — comes back "rejected". This file stands in for that interleaving:
// the mocked recordBidAtomic commits the bid row (the *other* delivery
// winning the race) and then reports a rejection, exactly what the losing
// delivery would see.
const race = vi.hoisted(() => ({ enabled: false }));

vi.mock("../../src/db/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/repository")>();
  return {
    ...actual,
    recordBidAtomic: async (params: Parameters<typeof actual.recordBidAtomic>[0]) => {
      if (!race.enabled) return actual.recordBidAtomic(params);
      await actual.recordBidAtomic(params); // the other delivery, committing first
      return { outcome: "rejected" as const, reason: "Bidding for this round has closed." };
    },
  };
});

const { recordBid } = await import("../../src/engine/recordBid");

afterEach(async () => {
  race.enabled = false;
  await db.delete(bids);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

describe("recordBid — concurrent duplicate delivery", () => {
  it("does not release the hold of a bid the other delivery already recorded", async () => {
    const startsAt = new Date();
    const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: startsAt }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt, phase: "bidding" }).returning();
    const provider = new FakePaymentProvider();
    race.enabled = true;

    const result = await recordBid(
      { roundId: round.id, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", now: new Date() },
      provider,
      new FakeNotifier(),
    );

    expect(result.outcome).toBe("already-recorded");
    expect(provider.releases).toEqual([]);
    const [bid] = await db.select().from(bids).where(eq(bids.paymentRef, "pi_a"));
    expect(bid.refundedAt).toBeNull();
  });
});
