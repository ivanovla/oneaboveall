import { describe, it, expect, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids } from "../../src/db/schema";
import { recordBid } from "../../src/engine/recordBid";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";

afterEach(async () => {
  await db.delete(bids);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

async function seedRound(priceCents: number, phase: "bidding" | "closed" = "bidding") {
  const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents, startedAt: new Date() }).returning();
  const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date(), phase }).returning();
  return round.id;
}

describe("recordBid", () => {
  it("records a bid with no one to refund when the queue was empty", async () => {
    const roundId = await seedRound(10_000);
    const provider = new FakePaymentProvider();

    const result = await recordBid({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", now: new Date() }, provider);

    expect(result.outcome).toBe("recorded");
    expect(provider.refunds).toEqual([]);
    const [bid] = await db.select().from(bids).where(eq(bids.paymentRef, "pi_a"));
    expect(bid.refundedAt).toBeNull();
  });

  it("refunds the previous leader in full when a new bid displaces them", async () => {
    const roundId = await seedRound(10_000);
    const provider = new FakePaymentProvider();

    await recordBid({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", now: new Date() }, provider);
    const result = await recordBid({ roundId, bidderId: "b", amountCents: 12_000, paymentRef: "pi_b", now: new Date() }, provider);

    expect(result.outcome).toBe("recorded");
    expect(provider.refunds).toEqual(["pi_a"]);

    const [previous] = await db.select().from(bids).where(eq(bids.paymentRef, "pi_a"));
    expect(previous.refundedAt).not.toBeNull();
    const [current] = await db.select().from(bids).where(eq(bids.paymentRef, "pi_b"));
    expect(current.refundedAt).toBeNull();
  });

  it("refunds the just-succeeded charge when the bid no longer qualifies by the time the webhook lands", async () => {
    const roundId = await seedRound(10_000);
    const provider = new FakePaymentProvider();

    // "a" leads with a higher amount than what "b"'s already-charged payment
    // intent (created a moment earlier, before "a" outbid) is for.
    await recordBid({ roundId, bidderId: "a", amountCents: 50_000, paymentRef: "pi_a", now: new Date() }, provider);
    const result = await recordBid({ roundId, bidderId: "b", amountCents: 11_000, paymentRef: "pi_b", now: new Date() }, provider);

    expect(result.outcome).toBe("refunded");
    expect(provider.refunds).toEqual(["pi_b"]);
    const rows = await db.select().from(bids).where(eq(bids.paymentRef, "pi_b"));
    expect(rows).toHaveLength(0);
  });

  it("refunds rather than records once the round has closed", async () => {
    const roundId = await seedRound(10_000, "closed");
    const provider = new FakePaymentProvider();

    const result = await recordBid({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", now: new Date() }, provider);

    expect(result.outcome).toBe("refunded");
    expect(provider.refunds).toEqual(["pi_a"]);
  });

  it("is idempotent — a redelivered webhook for an already-recorded bid neither re-inserts nor re-refunds", async () => {
    const roundId = await seedRound(10_000);
    const provider = new FakePaymentProvider();

    await recordBid({ roundId, bidderId: "a", amountCents: 11_000, paymentRef: "pi_a", now: new Date() }, provider);
    await recordBid({ roundId, bidderId: "b", amountCents: 12_000, paymentRef: "pi_b", now: new Date() }, provider);
    expect(provider.refunds).toEqual(["pi_a"]);

    const redelivered = await recordBid({ roundId, bidderId: "b", amountCents: 12_000, paymentRef: "pi_b", now: new Date() }, provider);
    expect(redelivered.outcome).toBe("already-recorded");
    expect(provider.refunds).toEqual(["pi_a"]); // no additional refund
  });
});
