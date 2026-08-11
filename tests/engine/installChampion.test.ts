import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { reigns, rounds } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { installChampion } from "../../src/engine/installChampion";
import { eq, isNull, sql } from "drizzle-orm";

afterEach(async () => {
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

describe("installChampion", () => {
  it("ends the previous reign and starts a new one", async () => {
    const first = await createInitialReign("first", new Date(2026, 0, 1));
    const now = new Date(2026, 0, 2);

    const second = await installChampion("second", 11_000, now);

    const [endedFirst] = await db.select().from(reigns).where(eq(reigns.id, first.id));
    expect(endedFirst.endedAt).toEqual(now);

    expect(second.occupantId).toBe("second");
    expect(second.priceCents).toBe(11_000);
    expect(second.endedAt).toBeNull();
  });

  it("creates a fresh bidding-phase round for the new reign", async () => {
    await createInitialReign("first", new Date(2026, 0, 1));
    const now = new Date(2026, 0, 2);
    const second = await installChampion("second", 11_000, now);

    const [round] = await db.select().from(rounds).where(eq(rounds.reignId, second.id));
    expect(round.phase).toBe("bidding");
    expect(round.startsAt).toEqual(now);
  });

  it("invokes the onInstalled callback with the new occupant id", async () => {
    await createInitialReign("first", new Date(2026, 0, 1));
    let notified: string | null = null;
    await installChampion("second", 11_000, new Date(2026, 0, 2), (occupantId) => {
      notified = occupantId;
    });
    expect(notified).toBe("second");
  });

  it("never leaves two simultaneously-active reigns when two installs race, via a genuine SERIALIZABLE conflict", async () => {
    await createInitialReign("first", new Date(2026, 0, 1));
    const now = new Date(2026, 0, 2);

    // Pre-warm two pool connections in parallel first. Without this, the second
    // installChampion call below can pay a cold `pool.connect()` penalty that lets
    // the first transaction fully commit before the second even starts its first
    // SELECT — the two calls end up serialized by accident (no SQLSTATE 40001 ever
    // fires) rather than genuinely racing inside Postgres's SERIALIZABLE isolation.
    await Promise.all([db.execute(sql`select 1`), db.execute(sql`select 1`)]);

    // Both `activeCount === 1` (data integrity) and `retryCount >= 1` (a genuine
    // conflict-and-retry actually happened, not accidental sequencing) must hold —
    // see the identical reasoning in tests/engine/bootstrap.test.ts.
    let retryCount = 0;
    const onRetry = () => {
      retryCount += 1;
    };

    const [a, b] = await Promise.all([
      installChampion("second", 11_000, now, undefined, { onRetry }),
      installChampion("third", 12_000, now, undefined, { onRetry }),
    ]);

    const active = await db.select().from(reigns).where(isNull(reigns.endedAt));
    expect(active.length).toBe(1);
    expect([a.id, b.id]).toContain(active[0].id);
    expect(retryCount).toBeGreaterThanOrEqual(1);
  });
});
