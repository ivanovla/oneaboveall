import { describe, it, expect, afterEach, afterAll, beforeEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { buildServer } from "../src/server";
import { db, pool } from "engine/db/client";
import { bids, refVisits, reigns, rounds, sessions, users } from "engine/db/schema";
import { createInitialReign } from "engine/engine/bootstrap";
import { getLatestRound } from "engine/db/repository";

vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const TOKEN = "test-admin-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };

beforeEach(() => {
  process.env.ADMIN_TOKEN = TOKEN;
});

afterEach(async () => {
  delete process.env.ADMIN_TOKEN;
  await db.delete(bids);
  await db.delete(rounds);
  await db.delete(reigns);
  await db.delete(refVisits);
  await db.delete(sessions);
  await db.delete(users);
});

afterAll(async () => {
  await pool.end();
});

async function user(providerId: string, extra: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await db
    .insert(users)
    .values({ provider: "google", providerId, email: `${providerId}@example.com`, name: providerId, ...extra })
    .returning();
  return row;
}

const ROUTES = [
  { method: "GET" as const, url: "/admin/stats" },
  { method: "GET" as const, url: "/admin/round" },
  { method: "GET" as const, url: "/admin/photos/00000000-0000-4000-8000-000000000000" },
  { method: "PATCH" as const, url: "/admin/users/00000000-0000-4000-8000-000000000000", payload: { sponsored: true } },
];

describe("admin auth", () => {
  for (const route of ROUTES) {
    it(`${route.method} ${route.url} 404s like an unknown route when ADMIN_TOKEN is unset`, async () => {
      delete process.env.ADMIN_TOKEN;
      const app = buildServer();
      const response = await app.inject({ ...route, headers: auth });
      expect(response.statusCode).toBe(404);
      const unknown = await app.inject({ method: "GET", url: "/definitely-not-a-route" });
      expect(Object.keys(response.json()).sort()).toEqual(Object.keys(unknown.json()).sort());
    });

    it(`${route.method} ${route.url} returns 401 without the right bearer token`, async () => {
      const app = buildServer();
      for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: TOKEN }, { authorization: `Bearer ${TOKEN}x` }]) {
        const response = await app.inject({ ...route, headers });
        expect(response.statusCode).toBe(401);
      }
    });
  }

  it("treats an empty ADMIN_TOKEN as unset", async () => {
    process.env.ADMIN_TOKEN = "";
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/admin/stats", headers: { authorization: "Bearer " } });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /admin/stats", () => {
  it("returns the per-ref funnel and totals", async () => {
    await db.insert(refVisits).values({ ref: "bob", count: 5 });
    await user("s1", { ref: "bob" });
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/admin/stats", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      refs: [{ ref: "bob", visits: 5, signups: 1, bidders: 0, winners: 0, revenueCents: 0 }],
      totals: { visits: 5, signups: 1, bidders: 0, winners: 0, revenueCents: 0 },
    });
  });
});

describe("GET /admin/round", () => {
  it("returns leader and runner-up with contact details", async () => {
    const startsAt = new Date(2026, 0, 1);
    const reign = await createInitialReign("champ", startsAt);
    const round = (await getLatestRound(reign.id))!;
    const a = await user("lead");
    const b = await user("runner");
    await db.insert(bids).values([
      { roundId: round.id, bidderId: b.id, amountCents: 110_000, paymentRef: "pi_a1", placedAt: new Date(startsAt.getTime() + 1000) },
      { roundId: round.id, bidderId: a.id, amountCents: 120_000, paymentRef: "pi_a2", placedAt: new Date(startsAt.getTime() + 2000) },
    ]);

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/admin/round", headers: auth });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.leader).toMatchObject({ userId: a.id, email: "lead@example.com", amountCents: 120_000, captured: false, hasPhoto: false });
    expect(body.runnerUp).toMatchObject({ userId: b.id, email: "runner@example.com", amountCents: 110_000 });
    expect(body.round.id).toBe(round.id);
  });
});

describe("GET /admin/photos/:userId", () => {
  it("serves any user's stored photo to the operator", async () => {
    const u = await user("photo-owner");
    await mkdir(UPLOAD_DIR, { recursive: true });
    const file = path.join(UPLOAD_DIR, `${u.id}.jpg`);
    await writeFile(file, "jpeg-bytes");
    await db.update(users).set({ photoPath: `${u.id}.jpg` }).where(eq(users.id, u.id));

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: `/admin/photos/${u.id}`, headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.body).toBe("jpeg-bytes");
    await unlink(file).catch(() => {});
  });

  it("400s a malformed id and 404s a user with no photo", async () => {
    const u = await user("no-photo");
    const app = buildServer();
    expect((await app.inject({ method: "GET", url: "/admin/photos/nope", headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/admin/photos/${u.id}`, headers: auth })).statusCode).toBe(404);
  });
});

describe("PATCH /admin/users/:id", () => {
  it("marks a creator sponsored, clears their link and photo and renames them", async () => {
    const u = await user("creator", { socialUrl: "https://spam.example", photoPath: "placeholder.jpg" });
    await mkdir(UPLOAD_DIR, { recursive: true });
    const file = path.join(UPLOAD_DIR, `${u.id}.jpg`);
    await writeFile(file, "jpeg-bytes");

    const app = buildServer();
    const response = await app.inject({
      method: "PATCH",
      url: `/admin/users/${u.id}`,
      headers: auth,
      payload: { sponsored: true, clearSocialUrl: true, clearPhoto: true, name: "  Clean Name  " },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ userId: u.id, sponsored: true, socialUrl: null, hasPhoto: false, name: "Clean Name" });

    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.sponsored).toBe(true);
    expect(row.socialUrl).toBeNull();
    expect(row.photoPath).toBeNull();
    expect(row.name).toBe("Clean Name");
    expect(existsSync(file)).toBe(false);
  });

  it("validates the id and the body", async () => {
    const u = await user("validate");
    const app = buildServer();
    const patch = (url: string, payload: unknown) => app.inject({ method: "PATCH", url, headers: auth, payload: payload as object });

    expect((await patch("/admin/users/not-a-uuid", { sponsored: true })).statusCode).toBe(400);
    expect((await patch(`/admin/users/${u.id}`, {})).statusCode).toBe(400);
    expect((await patch(`/admin/users/${u.id}`, { sponsored: "yes" })).statusCode).toBe(400);
    expect((await patch(`/admin/users/${u.id}`, { clearPhoto: false })).statusCode).toBe(400);
    expect((await patch(`/admin/users/${u.id}`, { name: "   " })).statusCode).toBe(400);
    expect((await patch(`/admin/users/${u.id}`, { name: "x".repeat(81) })).statusCode).toBe(400);
    expect((await patch("/admin/users/00000000-0000-4000-8000-000000000000", { sponsored: true })).statusCode).toBe(404);

    const ok = await patch(`/admin/users/${u.id}`, { sponsored: false });
    expect(ok.statusCode).toBe(200);
  });
});
