import { describe, it, expect, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns, rounds } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { getCurrentReign, getLatestRound } from "../../src/db/repository";
import { STARTING_PRICE_CENTS } from "../../src/domain/config";

afterEach(async () => {
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

describe("createInitialReign", () => {
  it("installs the first champion at the fixed starting price", async () => {
    const now = new Date(2026, 0, 1, 12, 0, 0);
    const reign = await createInitialReign("first-user", now);
    expect(reign.priceCents).toBe(STARTING_PRICE_CENTS);
    expect(reign.occupantId).toBe("first-user");

    const current = await getCurrentReign();
    expect(current?.id).toBe(reign.id);
  });

  it("also creates the first round in the bidding phase", async () => {
    const now = new Date(2026, 0, 1, 12, 0, 0);
    const reign = await createInitialReign("first-user", now);
    const round = await getLatestRound(reign.id);
    expect(round?.phase).toBe("bidding");
    expect(round?.startsAt).toEqual(now);
  });

  it("refuses to bootstrap if a reign already exists", async () => {
    await createInitialReign("first-user", new Date(2026, 0, 1));
    await expect(createInitialReign("second-user", new Date(2026, 0, 2))).rejects.toThrow();
  });

  it("only lets one of two simultaneous bootstrap attempts win, via a genuine SERIALIZABLE conflict", async () => {
    // Pre-warm two pool connections in parallel first. Without this, the second
    // createInitialReign call below can pay a cold `pool.connect()` penalty that lets
    // the first transaction fully commit before the second even starts its first
    // SELECT — the two calls end up serialized by accident (no SQLSTATE 40001 ever
    // fires) rather than genuinely racing inside Postgres's SERIALIZABLE isolation.
    // Warming both connections first ensures the two transactions below actually
    // overlap, so this test exercises the real conflict-and-retry path.
    await Promise.all([db.execute(sql`select 1`), db.execute(sql`select 1`)]);

    // `successCount === 1` alone is satisfied both by a genuine SERIALIZABLE conflict
    // (one transaction aborted with 40001 and correctly retried-and-failed) and
    // by the two calls running accidentally sequentially (no conflict at all,
    // second call just sees the first's committed row via ordinary validation).
    // Those two outcomes are indistinguishable from `successCount` alone, which is
    // exactly how the pre-warm fix above stayed silently unverified. To make the
    // mechanism itself assertable, count retries via `onRetry` — this only fires
    // when the loop catches SQLSTATE 40001 — and require at least one to have
    // happened. If someone drops `isolationLevel: "serializable"` or the pool
    // stops overlapping the two transactions, this assertion fails even though
    // `successCount` would still happen to be 1.
    let retryCount = 0;
    const onRetry = () => {
      retryCount += 1;
    };
    const now = new Date(2026, 0, 1, 12, 0, 0);

    const results = await Promise.all([
      createInitialReign("user-a", now, { onRetry }).then(
        () => ({ ok: true }),
        () => ({ ok: false }),
      ),
      createInitialReign("user-b", now, { onRetry }).then(
        () => ({ ok: true }),
        () => ({ ok: false }),
      ),
    ]);
    const successCount = results.filter((r) => r.ok).length;
    expect(successCount).toBe(1);
    expect(retryCount).toBeGreaterThanOrEqual(1);
  });
});
