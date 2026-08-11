import { describe, it, expect, afterEach, afterAll } from "vitest";
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
});
