import { describe, it, expect, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { refVisits, users } from "../../src/db/schema";
import { incrementRefVisits, setUserAttributionOnce, getUserAttribution } from "../../src/db/attribution";

afterEach(async () => {
  await db.delete(refVisits);
  await db.delete(users);
});

afterAll(async () => {
  await pool.end();
});

const empty = { ref: null, utmSource: null, utmMedium: null, utmCampaign: null, utmContent: null };

describe("incrementRefVisits", () => {
  it("creates a ref's row on first visit and increments it after, even concurrently", async () => {
    await Promise.all([incrementRefVisits("bob"), incrementRefVisits("bob"), incrementRefVisits("bob")]);
    expect(await incrementRefVisits("bob")).toBe(4);
    expect(await incrementRefVisits("alice")).toBe(1);
  });
});

describe("setUserAttributionOnce", () => {
  it("records first touch once and never overwrites it", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-attr-1", email: "a@example.com", name: "A" }).returning();
    const now = new Date("2026-10-02T10:00:00Z");

    expect(await setUserAttributionOnce(user.id, { ...empty, ref: "bob", utmSource: "twitch" }, now)).toBe(true);
    expect(await setUserAttributionOnce(user.id, { ...empty, ref: "alice" }, new Date())).toBe(false);

    expect(await getUserAttribution(user.id)).toEqual({ ...empty, ref: "bob", utmSource: "twitch" });
    const [row] = await db.select({ attributedAt: users.attributedAt }).from(users).where(eq(users.id, user.id));
    expect(row.attributedAt).toEqual(now);
  });

  it("records nothing (leaving the slot open) for an all-empty attribution", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-attr-2", email: "b@example.com", name: "B" }).returning();
    expect(await setUserAttributionOnce(user.id, empty, new Date())).toBe(false);
    expect(await setUserAttributionOnce(user.id, { ...empty, utmCampaign: "launch" }, new Date())).toBe(true);
  });
});
