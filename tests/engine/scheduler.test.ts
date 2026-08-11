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

  it("carries a reign across multiple rounds until someone pays", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    await createInitialReign("champ", startsAt);
    const provider = new FakePaymentProvider();

    // Day 1: nobody bids.
    await tick(new Date(startsAt.getTime() + ROUND_MS - 1000), provider);

    // Day 2: a challenger bids, then pays.
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
  });
});
