// tests/db/schema.test.ts
import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { reigns } from "../../src/db/schema";

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
});
