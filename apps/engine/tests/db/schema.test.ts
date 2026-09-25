// tests/db/schema.test.ts
import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, users, sessions } from "../../src/db/schema";

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

  it("can insert and read a bid, and rejects a duplicate paymentRef", async () => {
    const [reign] = await db.insert(reigns).values({ occupantId: "u1", priceCents: 10_000, startedAt: new Date() }).returning();
    const [round] = await db.insert(rounds).values({ reignId: reign.id, startsAt: new Date() }).returning();

    const [inserted] = await db
      .insert(bids)
      .values({ roundId: round.id, bidderId: "bidder-1", amountCents: 11_000, paymentRef: "pi_1" })
      .returning();
    expect(inserted.refundedAt).toBeNull();
    expect(inserted.paymentRef).toBe("pi_1");

    await expect(
      db.insert(bids).values({ roundId: round.id, bidderId: "bidder-2", amountCents: 12_000, paymentRef: "pi_1" }),
    ).rejects.toThrow();

    await db.delete(bids).where(eq(bids.id, inserted.id));
    await db.delete(rounds).where(eq(rounds.id, round.id));
    await db.delete(reigns).where(eq(reigns.id, reign.id));
  });

  it("can insert a user and a session, and rejects a duplicate (provider, providerId)", async () => {
    const [user] = await db
      .insert(users)
      .values({ provider: "google", providerId: "g-1", email: "a@example.com", name: "A" })
      .returning();
    expect(user.id).toBeTruthy();

    await expect(
      db.insert(users).values({ provider: "google", providerId: "g-1", email: "dup@example.com", name: "Dup" }),
    ).rejects.toThrow();

    const [session] = await db
      .insert(sessions)
      .values({ token: "tok_1", userId: user.id, expiresAt: new Date(Date.now() + 3600_000) })
      .returning();
    expect(session.userId).toBe(user.id);

    await db.delete(sessions).where(eq(sessions.token, "tok_1"));
    await db.delete(users).where(eq(users.id, user.id));
  });
});
