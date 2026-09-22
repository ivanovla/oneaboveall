// Isolated in its own file because it mocks the repository module: placeBidAtomic
// is forced to throw so placeBid's error path can be exercised without a
// clean way to provoke a genuine throw from a healthy database.
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
import { reigns, rounds, bids, bans, roundParticipants } from "../../src/db/schema";
import { createInitialReign } from "../../src/engine/bootstrap";
import { placeBid } from "../../src/engine/placeBid";
import { getLatestRound } from "../../src/db/repository";

afterEach(async () => {
  await db.delete(roundParticipants);
  await db.delete(bids);
  await db.delete(bans);
  await db.delete(rounds);
  await db.delete(reigns);
});

afterAll(async () => {
  await pool.end();
});

describe("placeBid when placeBidAtomic throws", () => {
  it("propagates the failure — nothing was charged here, so there is nothing to refund", async () => {
    const startsAt = new Date(2026, 0, 1, 0, 0, 0);
    const reign = await createInitialReign("champ", startsAt);
    const round = await getLatestRound(reign.id);
    await db.insert(roundParticipants).values({ roundId: round!.id, bidderId: "challenger", depositCents: 1_000, depositRef: "pi_1", paymentMethodRef: "pm_1", customerRef: "cus_1" });

    await expect(
      placeBid({ bidderId: "challenger", amountCents: 11_000, now: new Date(startsAt.getTime() + 1000) }),
    ).rejects.toThrow("simulated database failure");

    expect(await db.select().from(bids)).toHaveLength(0);
  });
});
