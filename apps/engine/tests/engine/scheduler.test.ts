// tests/engine/scheduler.test.ts
import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { tick } from "../../src/engine/scheduler";
import { getCurrentReign, getLatestRound } from "../../src/db/repository";
import { CHAMPION_PROCESSING_GAP_MS } from "../../src/domain/config";
import { nextDailyCloseAt } from "../../src/domain/dailyClose";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";
import { FakeNotifier } from "../../src/notifications/FakeNotifier";

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

async function bidByRef(paymentRef: string) {
  const [bid] = await db.select().from(bids).where(eq(bids.paymentRef, paymentRef));
  return bid;
}

const startsAt = new Date(2026, 0, 1, 0, 0, 0);
const closeAt = nextDailyCloseAt(startsAt);
const justAfterClose = new Date(closeAt.getTime() + 1000);
const afterGap = new Date(closeAt.getTime() + CHAMPION_PROCESSING_GAP_MS + 1000);

describe("tick", () => {
  it("rolls an empty round straight into the next day's round", async () => {
    const reign = await createInitialReign("champ", startsAt);

    await tick(justAfterClose, { provider: new FakePaymentProvider() });

    const round = await getLatestRound(reign.id);
    expect(round?.startsAt).toEqual(closeAt);
    expect(round?.phase).toBe("bidding");
  });

  it("settles (captures) the winner right at the close, but does not install them until the processing gap has elapsed", async () => {
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    await db.insert(bids).values({ roundId, bidderId: "runner-up", amountCents: 11_000, paymentRef: "pi_runner", placedAt: new Date(startsAt.getTime() + 1000) });
    await db.insert(bids).values({ roundId, bidderId: "winner", amountCents: 12_000, paymentRef: "pi_winner", placedAt: new Date(startsAt.getTime() + 2000) });
    const provider = new FakePaymentProvider();
    const notifier = new FakeNotifier();
    const onInstalled = vi.fn();

    await tick(justAfterClose, { provider, notifier, onInstalled });

    expect(provider.captures).toEqual(["pi_winner"]);
    expect(provider.releases).toEqual(["pi_runner"]);
    expect((await bidByRef("pi_winner")).capturedAt).not.toBeNull();
    expect(notifier.wins).toEqual([{ bidderId: "winner", amountCents: 12_000 }]);
    // The outgoing champion keeps showing while the winner's art is prepared.
    expect(onInstalled).not.toHaveBeenCalled();
    expect((await getCurrentReign())?.occupantId).toBe("champ");

    // Further ticks inside the gap neither re-capture nor re-notify.
    await tick(new Date(justAfterClose.getTime() + 60_000), { provider, notifier, onInstalled });
    expect(provider.captures).toEqual(["pi_winner"]);
    expect(notifier.wins).toHaveLength(1);
  });

  it("installs a captured winner once the processing gap has elapsed", async () => {
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    await db.insert(bids).values({ roundId, bidderId: "winner", amountCents: 11_000, paymentRef: "pi_winner", placedAt: new Date(startsAt.getTime() + 1000) });
    const provider = new FakePaymentProvider();

    await tick(justAfterClose, { provider });
    let installedOccupantId: string | undefined;
    await tick(afterGap, { provider, onInstalled: (occupantId) => (installedOccupantId = occupantId) });

    expect(installedOccupantId).toBe("winner");
    const current = await getCurrentReign();
    expect(current?.occupantId).toBe("winner");

    // installChampion starts the new reign's round at the moment of
    // installation, not on the ideal-schedule grid.
    const nextRound = await getLatestRound(current!.id);
    expect(nextRound?.startsAt).toEqual(afterGap);
    expect(nextRound?.phase).toBe("bidding");
  });

  it("settles and installs in one tick when the first tick after the close is already past the gap (e.g. after downtime)", async () => {
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    await db.insert(bids).values({ roundId, bidderId: "winner", amountCents: 11_000, paymentRef: "pi_winner", placedAt: new Date(startsAt.getTime() + 1000) });
    const provider = new FakePaymentProvider();

    await tick(afterGap, { provider });

    expect(provider.captures).toEqual(["pi_winner"]);
    expect((await getCurrentReign())?.occupantId).toBe("winner");
  });

  it("falls back to the runner-up when the leader's capture is declined", async () => {
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    await db.insert(bids).values({ roundId, bidderId: "runner-up", amountCents: 11_000, paymentRef: "pi_runner", placedAt: new Date(startsAt.getTime() + 1000) });
    await db.insert(bids).values({ roundId, bidderId: "declined", amountCents: 12_000, paymentRef: "pi_declined", placedAt: new Date(startsAt.getTime() + 2000) });
    const provider = new FakePaymentProvider();
    provider.declineCapture.add("pi_declined");

    await tick(justAfterClose, { provider });
    await tick(afterGap, { provider });

    expect((await getCurrentReign())?.occupantId).toBe("runner-up");
    expect((await bidByRef("pi_declined")).captureFailedAt).not.toBeNull();
  });

  it("empty-closes the round immediately when no hold can be captured", async () => {
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    await db.insert(bids).values({ roundId, bidderId: "declined", amountCents: 11_000, paymentRef: "pi_declined", placedAt: new Date(startsAt.getTime() + 1000) });
    const provider = new FakePaymentProvider();
    provider.declineCapture.add("pi_declined");

    await tick(justAfterClose, { provider });

    const current = await getCurrentReign();
    expect(current?.occupantId).toBe("champ");
    const [closedRound] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(closedRound.phase).toBe("closed");
    const next = await getLatestRound(current!.id);
    expect(next?.startsAt).toEqual(closeAt);
    expect(next?.phase).toBe("bidding");
  });

  it("a transient capture error leaves the round untouched and is retried on the next tick", async () => {
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    await db.insert(bids).values({ roundId, bidderId: "winner", amountCents: 11_000, paymentRef: "pi_winner", placedAt: new Date(startsAt.getTime() + 1000) });
    const provider = new FakePaymentProvider();
    provider.throwOnCapture.add("pi_winner");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await tick(afterGap, { provider });

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    const [round] = await db.select().from(rounds).where(eq(rounds.id, roundId));
    expect(round.phase).toBe("bidding");
    expect((await bidByRef("pi_winner")).refundedAt).toBeNull();
    expect((await getCurrentReign())?.occupantId).toBe("champ");

    provider.throwOnCapture.clear();
    await tick(new Date(afterGap.getTime() + 3000), { provider });
    expect((await getCurrentReign())?.occupantId).toBe("winner");
  });

  it("installs the captured winner on schedule even when releasing another hold keeps failing", async () => {
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    await db.insert(bids).values({ roundId, bidderId: "stuck", amountCents: 11_000, paymentRef: "pi_stuck", placedAt: new Date(startsAt.getTime() + 1000) });
    await db.insert(bids).values({ roundId, bidderId: "winner", amountCents: 12_000, paymentRef: "pi_winner", placedAt: new Date(startsAt.getTime() + 2000) });
    const provider = new FakePaymentProvider();
    provider.throwOnRelease.add("pi_stuck");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await tick(justAfterClose, { provider });
    await tick(afterGap, { provider });

    errorSpy.mockRestore();
    expect((await getCurrentReign())?.occupantId).toBe("winner");
    expect((await bidByRef("pi_stuck")).refundedAt).toBeNull();
  });

  it("survives an empty day, chaining into a new round for the same reign", async () => {
    await createInitialReign("champ", startsAt);

    await tick(justAfterClose, { provider: new FakePaymentProvider() });

    const afterDay1 = await getCurrentReign();
    expect(afterDay1?.occupantId).toBe("champ");
    const day2Round = await getLatestRound(afterDay1!.id);
    expect(day2Round?.startsAt).toEqual(closeAt);
    expect(day2Round?.phase).toBe("bidding");
  });

  it("ignores a bid placed after the bidding window closed when picking the winner", async () => {
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    await db.insert(bids).values({ roundId, bidderId: "honest", amountCents: 11_000, paymentRef: "pi_honest", placedAt: new Date(startsAt.getTime() + 1000) });
    await db.insert(bids).values({ roundId, bidderId: "sniper", amountCents: 99_000, paymentRef: "pi_sniper", placedAt: new Date(closeAt.getTime() + 1000) });
    const provider = new FakePaymentProvider();

    await tick(new Date(closeAt.getTime() + CHAMPION_PROCESSING_GAP_MS + 5000), { provider });

    expect((await getCurrentReign())?.occupantId).toBe("honest");
    expect(provider.captures).toEqual(["pi_honest"]);
  });

  it("a round that isn't due yet is left untouched", async () => {
    const reign = await createInitialReign("champ", startsAt);
    const roundId = await currentRoundId(reign.id);
    await db.insert(bids).values({ roundId, bidderId: "bidder", amountCents: 11_000, paymentRef: "pi_bidder" });
    const provider = new FakePaymentProvider();

    await tick(new Date(startsAt.getTime() + 1000), { provider });

    expect(provider.captures).toEqual([]);
    const current = await getCurrentReign();
    expect(current?.occupantId).toBe("champ");
    const round = await getLatestRound(current!.id);
    expect(round?.phase).toBe("bidding");
  });
});
