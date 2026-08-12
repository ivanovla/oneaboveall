// Isolated in its own file because it mocks the repository module: placeBidAtomic
// is forced to throw so the deposit-recovery path in placeBid can be exercised.
// There is no clean way to provoke a genuine throw from a healthy database once
// validateBidAmount rejects out-of-range amounts, which is the point of that
// validation — but a DB outage, a constraint violation or exhausted SERIALIZABLE
// retries all still surface here as a throw, with the deposit already charged.
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";

vi.mock("../../src/db/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/repository")>();
  return {
    ...actual,
    placeBidAtomic: vi.fn(async () => {
      throw new Error("simulated database failure inside placeBidAtomic");
    }),
  };
});

import { db, pool } from "../../src/db/client";
import { reigns, rounds, bids, bans } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { placeBid } from "../../src/engine/placeBid";
import { FakePaymentProvider } from "../../src/payments/FakePaymentProvider";

afterEach(async () => {
  await db.delete(bids);
  await db.delete(bans);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

describe("placeBid when placeBidAtomic throws", () => {
  it("refunds the already-charged deposit and returns a failure instead of throwing", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    await createInitialReign("champ", startsAt);
    const provider = new FakePaymentProvider();

    const result = await placeBid(
      { bidderId: "challenger", amountCents: 11_000, now: new Date(startsAt.getTime() + 1000) },
      provider,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("refunded");

    // The deposit was charged before the failure — it must not be stranded.
    expect(provider.charges).toHaveLength(1);
    expect(provider.refunds).toEqual([provider.charges[0].ref]);

    expect(await db.select().from(bids)).toHaveLength(0);
  });
});
