import { describe, it, expect, afterEach, afterAll } from "vitest";
import { db, pool } from "../../src/db/client";
import { pageViews } from "../../src/db/schema";
import { incrementPageViews } from "../../src/db/repository";

afterEach(async () => {
  await db.delete(pageViews);
});

afterAll(async () => {
  await pool.end();
});

describe("incrementPageViews", () => {
  it("starts at 1 on the very first call", async () => {
    expect(await incrementPageViews()).toBe(1);
  });

  it("increments by exactly 1 on every subsequent call", async () => {
    await incrementPageViews();
    await incrementPageViews();
    expect(await incrementPageViews()).toBe(3);
  });

  it("never creates more than the single counter row", async () => {
    await incrementPageViews();
    await incrementPageViews();
    const rows = await db.select().from(pageViews);
    expect(rows).toHaveLength(1);
  });

  it("stays correct under concurrent calls", async () => {
    await Promise.all(Array.from({ length: 10 }, () => incrementPageViews()));
    const [row] = await db.select().from(pageViews);
    expect(row.count).toBe(10);
  });

  it("increments by the given batch amount instead of 1", async () => {
    expect(await incrementPageViews(7)).toBe(7);
    expect(await incrementPageViews(3)).toBe(10);
  });
});
