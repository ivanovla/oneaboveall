import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { buildServer } from "../src/server";
import { db, pool } from "engine/db/client";
import { refVisits, sessions, users } from "engine/db/schema";
import { createSession } from "../src/auth/session";

vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

afterEach(async () => {
  await db.delete(refVisits);
  await db.delete(sessions);
  await db.delete(users);
});

afterAll(async () => {
  await pool.end();
});

describe("POST /ref-visits", () => {
  it("counts a visit per valid ref and answers 204", async () => {
    const app = buildServer();
    for (const remoteAddress of ["198.51.100.1", "198.51.100.2"]) {
      const response = await app.inject({ method: "POST", url: "/ref-visits", payload: { ref: "streamer_bob" }, remoteAddress });
      expect(response.statusCode).toBe(204);
    }
    const [row] = await db.select().from(refVisits).where(eq(refVisits.ref, "streamer_bob"));
    expect(row.count).toBe(2);
  });

  it("counts the same IP + ref only once per window, still answering 204", async () => {
    const app = buildServer();
    for (let i = 0; i < 3; i++) {
      const response = await app.inject({ method: "POST", url: "/ref-visits", payload: { ref: "streamer_bob" }, remoteAddress: "198.51.100.7" });
      expect(response.statusCode).toBe(204);
    }
    const [row] = await db.select().from(refVisits).where(eq(refVisits.ref, "streamer_bob"));
    expect(row.count).toBe(1);
  });

  it("stops counting an IP after ~30 requests an hour, still answering 204", async () => {
    const app = buildServer();
    for (let i = 0; i < 35; i++) {
      const response = await app.inject({ method: "POST", url: "/ref-visits", payload: { ref: `ref_${i}` }, remoteAddress: "198.51.100.9" });
      expect(response.statusCode).toBe(204);
    }
    expect(await db.select().from(refVisits)).toHaveLength(30);
  });

  it("tells visitors apart by the client IP the ingress forwards, not the ingress's own address", async () => {
    const app = buildServer();
    for (const client of ["203.0.113.1", "203.0.113.2"]) {
      await app.inject({
        method: "POST",
        url: "/ref-visits",
        payload: { ref: "streamer_bob" },
        remoteAddress: "10.42.0.5", // the Traefik pod
        headers: { "x-forwarded-for": client },
      });
    }
    const [row] = await db.select().from(refVisits).where(eq(refVisits.ref, "streamer_bob"));
    expect(row.count).toBe(2);
  });

  it("can't dodge the limit by spoofing X-Forwarded-For — only the hop the ingress appended counts", async () => {
    const app = buildServer();
    for (const spoofed of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
      await app.inject({
        method: "POST",
        url: "/ref-visits",
        payload: { ref: "streamer_bob" },
        remoteAddress: "10.42.0.5",
        headers: { "x-forwarded-for": `${spoofed}, 203.0.113.1` },
      });
    }
    const [row] = await db.select().from(refVisits).where(eq(refVisits.ref, "streamer_bob"));
    expect(row.count).toBe(1);
  });

  it("is a silent 204 no-op for an invalid or missing ref", async () => {
    const app = buildServer();
    for (const payload of [{ ref: "<script>" }, { ref: "x".repeat(65) }, { ref: 7 }, {}]) {
      const response = await app.inject({ method: "POST", url: "/ref-visits", payload });
      expect(response.statusCode).toBe(204);
    }
    expect(await db.select().from(refVisits)).toEqual([]);
  });
});

describe("PATCH /auth/attribution", () => {
  async function signedIn() {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-attr", email: "a@example.com", name: "A" }).returning();
    const { token } = await createSession(user.id);
    return { user, cookie: `oneaboveall_session=${token}` };
  }

  it("requires a session", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "PATCH", url: "/auth/attribution", payload: { ref: "bob" } });
    expect(response.statusCode).toBe(401);
  });

  it("stores sanitized first-touch attribution once, dropping invalid values", async () => {
    const { user, cookie } = await signedIn();
    const app = buildServer();

    const first = await app.inject({
      method: "PATCH",
      url: "/auth/attribution",
      headers: { cookie },
      payload: { ref: "bob", utmSource: "twitch", utmMedium: "bad value!", utmCampaign: "launch.1", landingAt: "2026-10-02" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ recorded: true });

    const second = await app.inject({ method: "PATCH", url: "/auth/attribution", headers: { cookie }, payload: { ref: "alice" } });
    expect(second.json()).toEqual({ recorded: false });

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.ref).toBe("bob");
    expect(row.utmSource).toBe("twitch");
    expect(row.utmMedium).toBeNull();
    expect(row.utmCampaign).toBe("launch.1");
    expect(row.attributedAt).not.toBeNull();
  });
});
