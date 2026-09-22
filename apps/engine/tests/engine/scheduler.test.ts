// tests/engine/scheduler.test.ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans, paymentOffers, roundParticipants } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { placeBid } from "../../src/engine/placeBid";
import { tick } from "../../src/engine/scheduler";
import { getCurrentReign, getLatestRound } from "../../src/db/repository";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";
import type { PaymentProvider } from "../../src/payments/PaymentProvider";
import { BIDDING_PHASE_MS, ROUND_MS } from "../../src/domain/config";
import { eq } from "drizzle-orm";

afterEach(async () => {
  await db.delete(paymentOffers);
  await db.delete(roundParticipants);
  await db.delete(bids);
  await db.delete(bans);
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

async function join(roundId: string, bidderId: string) {
  await db.insert(roundParticipants).values({ roundId, bidderId, depositCents: 1_100, depositRef: `pi_${bidderId}`, paymentMethodRef: `pm_${bidderId}`, customerRef: `cus_${bidderId}` });
}

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

  it("settles a winning bid immediately, in the same tick that snapshots the round", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const provider = new FakePaymentProvider();
    await join(await currentRoundId(reign.id), "winner");

    const bidResult = await placeBid({ bidderId: "winner", amountCents: 11_000, now: new Date(startsAt.getTime() + 1000) });
    expect(bidResult.ok).toBe(true);

    const settlementAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000);
    await tick(settlementAt, provider);

    expect(provider.remainderCharges).toHaveLength(1);
    const current = await getCurrentReign();
    expect(current?.occupantId).toBe("winner");

    // installChampion (unchanged by this plan, see installChampion.test.ts
    // "creates a fresh bidding-phase round for the new reign") starts the new
    // reign's round at the moment of installation, not on the ideal-schedule
    // grid — a paid win begins the winner's round right away rather than
    // waiting for the slot the old round would otherwise have vacated.
    const nextRound = await getLatestRound(current!.id);
    expect(nextRound?.startsAt).toEqual(settlementAt);
    expect(nextRound?.phase).toBe("bidding");
  });

  it("survives an empty day then a failed off-session charge, chaining into a new round each time", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    await createInitialReign("champ", startsAt);
    const provider = new FakePaymentProvider();

    // Day 1: nobody bids.
    await tick(new Date(startsAt.getTime() + ROUND_MS - 1000), provider);

    // Day 2: a challenger bids, but their off-session charge fails.
    const day2Reign = await getCurrentReign();
    const day2Start = new Date(startsAt.getTime() + ROUND_MS);
    await join(await currentRoundId(day2Reign!.id), "winner");
    const bidResult = await placeBid({ bidderId: "winner", amountCents: 11_000, now: new Date(day2Start.getTime() + 1000) });
    expect(bidResult.ok).toBe(true);

    provider.failNextRemainderCharge("failed");
    await tick(new Date(day2Start.getTime() + BIDDING_PHASE_MS + 1000), provider);

    const afterSettlement = await getCurrentReign();
    expect(afterSettlement?.occupantId).toBe("champ"); // still champ, queue was exhausted after the one bidder

    const finalRound = await getLatestRound(afterSettlement!.id);
    expect(finalRound?.startsAt).toEqual(new Date(day2Start.getTime() + ROUND_MS));
    expect(finalRound?.phase).toBe("bidding");
  });

  it("never forfeits or bans the leader when the tick itself runs late", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const provider = new FakePaymentProvider();
    await join(await currentRoundId(reign.id), "unlucky");

    const bidResult = await placeBid({ bidderId: "unlucky", amountCents: 11_000, now: new Date(startsAt.getTime() + 1000) });
    expect(bidResult.ok).toBe(true);

    // 3h after the window closed — the 1h payment window (ending at T0+13h)
    // is long gone before the scheduler ever runs.
    await tick(new Date(startsAt.getTime() + BIDDING_PHASE_MS + 3 * 60 * 60 * 1000), provider);

    expect(await db.select().from(paymentOffers)).toHaveLength(0);
    expect(await db.select().from(bans)).toHaveLength(0);

    const [participant] = await db.select().from(roundParticipants).where(eq(roundParticipants.bidderId, "unlucky"));
    expect(participant.depositStatus).toBe("refunded");
    expect(provider.refunds).toEqual([participant.depositRef]);

    const current = await getCurrentReign();
    expect(current?.occupantId).toBe("champ");
    const nextRound = await getLatestRound(reign.id);
    expect(nextRound?.startsAt).toEqual(new Date(startsAt.getTime() + ROUND_MS));
    expect(nextRound?.phase).toBe("bidding");
  });

  it("crash-recovery: an offer stuck 'pending' past its expiry (as if a prior tick died mid-settlement) still gets settled", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const provider = new FakePaymentProvider();
    await join(await currentRoundId(reign.id), "winner");
    await placeBid({ bidderId: "winner", amountCents: 11_000, now: new Date(startsAt.getTime() + 1000) });

    // Simulate a prior tick that created the snapshot's offer (via
    // resolveBiddingPhaseSnapshot) but crashed before settleRound ever ran —
    // insert the pending offer directly rather than going through tick(), so
    // this test exercises tick()'s poll-based safety net, not its normal path.
    const roundId = await currentRoundId(reign.id);
    const [bid] = await db.select().from(bids).where(eq(bids.roundId, roundId));
    const offeredAt = new Date(startsAt.getTime() + BIDDING_PHASE_MS);
    await db.update(rounds).set({ phase: "payment" }).where(eq(rounds.id, roundId));
    await db.insert(paymentOffers).values({
      roundId,
      bidId: bid.id,
      offeredAt,
      expiresAt: new Date(offeredAt.getTime() + 1000),
      status: "pending",
    });

    await tick(new Date(offeredAt.getTime() + 2000), provider);

    expect(provider.remainderCharges).toHaveLength(1);
    const current = await getCurrentReign();
    expect(current?.occupantId).toBe("winner");
  });

  it("a provider outage during settlement is logged and isolated — no ban, no forfeit, no next round", async () => {
    // The counterpart to the engine-level guarantee: a throw from the payment
    // provider must reach tick()'s per-item catch, not a forfeit/ban path.
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    await join(await currentRoundId(reign.id), "unlucky");
    await placeBid({ bidderId: "unlucky", amountCents: 11_000, now: new Date(startsAt.getTime() + 1000) });

    const outageProvider: PaymentProvider = {
      async chargeRemainderOffSession() {
        throw new Error("stripe unavailable");
      },
      async refund() {},
    };

    await expect(tick(new Date(startsAt.getTime() + BIDDING_PHASE_MS + 1000), outageProvider)).resolves.toBeUndefined();

    expect(await db.select().from(bans)).toHaveLength(0);
    const [participant] = await db.select().from(roundParticipants).where(eq(roundParticipants.bidderId, "unlucky"));
    expect(participant.depositStatus).toBe("held");
    // The round is left mid-settlement rather than closed, so no next round
    // was started — the accepted "stuck offer" residual gap, which is the
    // right trade against wrongly punishing a bidder for our outage.
    expect(await db.select().from(rounds)).toHaveLength(1);
  });

  it("reconciliation sweep: refunds a deposit left 'held' on an already-closed round", async () => {
    // This residue can be left behind several ways — closeRoundAndRefundHeld
    // throwing part-way through its refund loop, joinRound's own race-refund
    // failing after the row was inserted, or a crash between the two. Nothing
    // else in the system ever revisits such a row, so without this sweep the
    // bidder's money stays with us permanently.
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    await join(roundId, "stranded");
    await db.update(rounds).set({ phase: "closed" }).where(eq(rounds.id, roundId));

    const provider = new FakePaymentProvider();
    await tick(new Date(startsAt.getTime() + ROUND_MS), provider);

    const [participant] = await db.select().from(roundParticipants).where(eq(roundParticipants.bidderId, "stranded"));
    expect(participant.depositStatus).toBe("refunded");
    expect(provider.refunds).toContain("pi_stranded");
  });

  it("reconciliation sweep: leaves a deposit 'held' (retryable) when the refund fails, and keeps sweeping the rest", async () => {
    // Per-item isolation, and the same refund-before-mark ordering used
    // everywhere else: a failed refund must never leave the row claiming
    // money was returned, or nothing would ever retry it.
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    await join(roundId, "doomed");
    await join(roundId, "fine");
    await db.update(rounds).set({ phase: "closed" }).where(eq(rounds.id, roundId));

    const refunded: string[] = [];
    const flakyProvider: PaymentProvider = {
      async chargeRemainderOffSession() {
        return "succeeded";
      },
      async refund(depositRef: string) {
        if (depositRef === "pi_doomed") throw new Error("stripe unavailable");
        refunded.push(depositRef);
      },
    };

    await tick(new Date(startsAt.getTime() + ROUND_MS), flakyProvider);

    const rows = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    const byBidder = Object.fromEntries(rows.map((r) => [r.bidderId, r.depositStatus]));
    expect(byBidder["doomed"]).toBe("held");
    expect(byBidder["fine"]).toBe("refunded");
    expect(refunded).toEqual(["pi_fine"]);
  });

  it("reconciliation sweep: leaves deposits on rounds that are still open alone", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    await join(roundId, "bidder");

    const provider = new FakePaymentProvider();
    // Well before the bidding window closes, so nothing else in tick() runs.
    await tick(new Date(startsAt.getTime() + 1000), provider);

    const [participant] = await db.select().from(roundParticipants).where(eq(roundParticipants.bidderId, "bidder"));
    expect(participant.depositStatus).toBe("held");
    expect(provider.refunds).toHaveLength(0);
  });
});
