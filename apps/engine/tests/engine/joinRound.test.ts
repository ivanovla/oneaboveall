import { describe, it, expect, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, roundParticipants } from "../../src/db/schema";
import { joinRound } from "../../src/engine/joinRound";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";

afterEach(async () => {
  await db.delete(roundParticipants);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

async function seedRound(phase: "bidding" | "resolving" | "payment" | "closed" = "bidding") {
  const [reign] = await db.insert(reigns).values({ occupantId: "champ", priceCents: 10_000, startedAt: new Date() }).returning();
  const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date(), phase }).returning();
  return round.id;
}

describe("joinRound", () => {
  it("creates a held round participant on first call", async () => {
    const roundId = await seedRound();
    const provider = new FakePaymentProvider();

    const result = await joinRound(
      { roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() },
      provider,
    );

    expect(result.outcome).toBe("joined");
    const [row] = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    expect(row.bidderId).toBe("a");
    expect(row.depositStatus).toBe("held");
    expect(provider.refunds).toHaveLength(0);
  });

  it("is idempotent — a duplicate call for the same (roundId, bidderId) is a safe no-op", async () => {
    const roundId = await seedRound();
    const provider = new FakePaymentProvider();

    await joinRound({ roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() }, provider);
    const second = await joinRound(
      { roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_2", paymentMethodRef: "pm_2", now: new Date() },
      provider,
    );

    expect(second.outcome).toBe("already-joined");
    const rows = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    expect(rows).toHaveLength(1);
  });

  it("two concurrent calls for the same (roundId, bidderId) resolve to exactly one 'joined'", async () => {
    const roundId = await seedRound();
    const provider = new FakePaymentProvider();

    const [a, b] = await Promise.all([
      joinRound({ roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() }, provider),
      joinRound({ roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_2", paymentMethodRef: "pm_2", now: new Date() }, provider),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["already-joined", "joined"]);
  });

  it("refunds immediately and does not grant bidding rights when the round already left the bidding phase", async () => {
    // A genuine race: the round can snapshot/close between the user clicking
    // "Join" and Stripe's webhook actually arriving. The deposit was already
    // charged — it must not be stranded as a "held" row nothing will ever
    // resolve.
    const roundId = await seedRound("resolving");
    const provider = new FakePaymentProvider();

    const result = await joinRound(
      { roundId, bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() },
      provider,
    );

    expect(result.outcome).toBe("refunded-round-closed");
    expect(provider.refunds).toEqual(["pi_1"]);
    const [row] = await db.select().from(roundParticipants).where(eq(roundParticipants.roundId, roundId));
    expect(row.depositStatus).toBe("refunded");
  });

  it("throws if the round does not exist", async () => {
    const provider = new FakePaymentProvider();
    await expect(
      joinRound(
        { roundId: "00000000-0000-0000-0000-000000000000", bidderId: "a", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", now: new Date() },
        provider,
      ),
    ).rejects.toThrow("Round not found");
  });
});
