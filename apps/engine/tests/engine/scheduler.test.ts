// tests/engine/scheduler.test.ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans, paymentOffers } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { placeBid } from "../../src/engine/placeBid";
import { tick } from "../../src/engine/scheduler";
import { getCurrentReign, getLatestRound } from "../../src/db/repository";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";
import { BIDDING_PHASE_MS, ROUND_MS } from "../../src/domain/config";
import { eq } from "drizzle-orm";

afterEach(async () => {
  await db.delete(paymentOffers);
  await db.delete(bids);
  await db.delete(bans);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

describe("tick", () => {
  it("rolls an empty round straight into the next day's round", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const provider = new FakePaymentProvider();

    await tick(new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000), provider);

    const round = await getLatestRound(reign.id);
    expect(round?.startsAt).toEqual(new Date(startsAt.getTime() + ROUND_MS));
    expect(round?.phase).toBe("bidding");
  });

  it("survives an empty day then a cascade that exhausts without payment, chaining into a new round each time", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    await createInitialReign("champ", startsAt);
    const provider = new FakePaymentProvider();

    // Day 1: nobody bids.
    await tick(new Date(startsAt.getTime() + ROUND_MS - 1000), provider);

    // Day 2: a challenger bids, but never pays.
    const day2Start = new Date(startsAt.getTime() + ROUND_MS);
    const bidResult = await placeBid({ bidderId: "winner", amountCents: 11_000, now: new Date(day2Start.getTime() + 1000) }, provider);
    expect(bidResult.ok).toBe(true);

    const snapshotTime = new Date(day2Start.getTime() + BIDDING_PHASE_MS + 1000);
    await tick(snapshotTime, provider);

    const [offer] = await db.select().from(paymentOffers).where(eq(paymentOffers.status, "pending"));
    expect(offer).toBeDefined();

    const current = await getCurrentReign();
    expect(current?.occupantId).toBe("champ"); // not yet paid

    // Payment never confirmed; let it expire and cascade/close.
    await tick(new Date(offer.expiresAt.getTime() + 1000), provider);

    const afterExpiry = await getCurrentReign();
    expect(afterExpiry?.occupantId).toBe("champ"); // still champ, queue was exhausted after the one bidder

    // The exhausted round-2 must have chained into a genuinely new round 3,
    // not just left the champion untouched — this is the behavior this test
    // is actually meant to cover (Finding 3, Task 13 review).
    const finalRound = await getLatestRound(afterExpiry!.id);
    expect(finalRound?.startsAt).toEqual(new Date(day2Start.getTime() + ROUND_MS));
    expect(finalRound?.phase).toBe("bidding");
  });

  it("never forfeits or bans the leader when the tick itself runs late", async () => {
    // The scheduler was down across the whole payment window. The offer this
    // tick would create expires before the tick's own expiry loop reaches it,
    // so without the guard the leader is forfeited and banned for 3 rounds
    // inside the very tick that first offered them the chance to pay.
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const provider = new FakePaymentProvider();

    const bidResult = await placeBid(
      { bidderId: "unlucky", amountCents: 11_000, now: new Date(startsAt.getTime() + 1000) },
      provider,
    );
    expect(bidResult.ok).toBe(true);

    // 3h after the window closed — the 1h payment window (ending at T0+13h)
    // is long gone.
    await tick(new Date(startsAt.getTime() + BIDDING_PHASE_MS + 3 * 60 * 60 * 1000), provider);

    expect(await db.select().from(paymentOffers)).toHaveLength(0);
    expect(await db.select().from(bans)).toHaveLength(0);

    const [bid] = await db.select().from(bids);
    expect(bid.depositStatus).toBe("refunded");
    expect(provider.refunds).toEqual([bid.depositRef]);

    // Still the same champion, and the schedule moved on to the next day.
    const current = await getCurrentReign();
    expect(current?.occupantId).toBe("champ");
    const nextRound = await getLatestRound(reign.id);
    expect(nextRound?.startsAt).toEqual(new Date(startsAt.getTime() + ROUND_MS));
    expect(nextRound?.phase).toBe("bidding");
  });
});
