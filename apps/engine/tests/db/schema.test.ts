// tests/db/schema.test.ts
import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, roundParticipants } from "../../src/db/schema";

describe("schema", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("can insert and read a reign", async () => {
    const [inserted] = await db
      .insert(reigns)
      .values({ occupantId: "test-user", priceCents: 10_000, startedAt: new Date() })
      .returning();

    const [found] = await db.select().from(reigns).where(eq(reigns.id, inserted.id)).limit(1);
    expect(found?.occupantId).toBe("test-user");

    await db.delete(reigns).where(eq(reigns.id, inserted.id));
  });

  it("can insert and read a round participant, and rejects a duplicate (roundId, bidderId)", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "u1", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();

    const [inserted] = await db
      .insert(roundParticipants)
      .values({ roundId: round.id, bidderId: "bidder-1", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1" })
      .returning();
    expect(inserted.depositStatus).toBe("held");

    await expect(
      db.insert(roundParticipants).values({ roundId: round.id, bidderId: "bidder-1", depositCents: 1_000, depositRef: "pi_2", paymentMethodRef: "pm_2" }),
    ).rejects.toThrow();

    await db.delete(roundParticipants).where(eq(roundParticipants.id, inserted.id));
    await db.delete(rounds).where(eq(rounds.id, round.id));
    await db.delete(reigns).where(eq(reigns.id, reign.id));
  });
});
