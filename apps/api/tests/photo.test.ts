import { describe, it, expect, afterEach, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { buildServer } from "../src/server";
import { db, pool } from "engine/db/client";
import { users, sessions } from "engine/db/schema";
import { eq } from "drizzle-orm";
import { createSession } from "../src/auth/session";

const UPLOAD_DIR = path.join(process.cwd(), "uploads");

// `consent` defaults to "true" so every existing call site — which is
// testing something other than the consent gate — keeps exercising a
// request that should succeed. Pass `consent: null` to omit the field
// entirely (simulating the checkbox never having been checked).
function buildMultipartBody(field: { filename: string; contentType: string; content: Buffer; consent?: string | null }): {
  body: Buffer;
  contentType: string;
} {
  const boundary = "----test-boundary-oneaboveall";
  const consent = field.consent === undefined ? "true" : field.consent;
  const consentPart =
    consent === null
      ? ""
      : `--${boundary}\r\n` + `Content-Disposition: form-data; name="consent"\r\n\r\n${consent}\r\n`;
  const head = Buffer.from(
    consentPart +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="photo"; filename="${field.filename}"\r\n` +
      `Content-Type: ${field.contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, field.content, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// DB cleanup only — each test that actually writes a file to disk removes
// it itself (the filename is `${user.id}.<ext>`, and that id doesn't exist
// until the test creates it, so a generic afterEach can't target it).
afterEach(async () => {
  await db.delete(sessions);
  await db.delete(users);
});

afterAll(async () => {
  await pool.end();
});

describe("POST /auth/photo", () => {
  it("returns 401 with no session cookie", async () => {
    const app = buildServer();
    const { body, contentType } = buildMultipartBody({ filename: "a.jpg", contentType: "image/jpeg", content: Buffer.from("fake-jpeg-bytes") });
    const response = await app.inject({ method: "POST", url: "/auth/photo", headers: { "content-type": contentType }, payload: body });
    expect(response.statusCode).toBe(401);
  });

  it("saves an uploaded JPEG to disk and records its path on the user", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-photo-1", email: "a@example.com", name: "A" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const { body, contentType } = buildMultipartBody({ filename: "selfie.jpg", contentType: "image/jpeg", content: Buffer.from("fake-jpeg-bytes") });
    const response = await app.inject({
      method: "POST",
      url: "/auth/photo",
      headers: { cookie: `oneaboveall_session=${token}`, "content-type": contentType },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ photoPath: `${user.id}.jpg` });

    const [row] = await db.select({ photoPath: users.photoPath, photoConsentAt: users.photoConsentAt }).from(users).where(eq(users.id, user.id));
    expect(row.photoPath).toBe(`${user.id}.jpg`);
    expect(row.photoConsentAt).not.toBeNull();

    const savedPath = path.join(UPLOAD_DIR, `${user.id}.jpg`);
    expect(existsSync(savedPath)).toBe(true);
    expect(readFileSync(savedPath).toString()).toBe("fake-jpeg-bytes");

    await unlink(savedPath).catch(() => {});
  });

  it("rejects an upload with no consent field, without touching the user row", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-photo-consent-1", email: "consent1@example.com", name: "Consent1" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const { body, contentType } = buildMultipartBody({ filename: "selfie.jpg", contentType: "image/jpeg", content: Buffer.from("fake-jpeg-bytes"), consent: null });
    const response = await app.inject({
      method: "POST",
      url: "/auth/photo",
      headers: { cookie: `oneaboveall_session=${token}`, "content-type": contentType },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "you must confirm you have the rights to this photo before uploading" });

    const [row] = await db.select({ photoPath: users.photoPath }).from(users).where(eq(users.id, user.id));
    expect(row.photoPath).toBeNull();
    expect(existsSync(path.join(UPLOAD_DIR, `${user.id}.jpg`))).toBe(false);
  });

  it('rejects an upload whose consent field isn\'t exactly "true"', async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-photo-consent-2", email: "consent2@example.com", name: "Consent2" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const { body, contentType } = buildMultipartBody({ filename: "selfie.jpg", contentType: "image/jpeg", content: Buffer.from("fake-jpeg-bytes"), consent: "false" });
    const response = await app.inject({
      method: "POST",
      url: "/auth/photo",
      headers: { cookie: `oneaboveall_session=${token}`, "content-type": contentType },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects a non-image content type with 400, without touching the user row", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-photo-2", email: "b@example.com", name: "B" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const { body, contentType } = buildMultipartBody({ filename: "not-a-photo.txt", contentType: "text/plain", content: Buffer.from("hello") });
    const response = await app.inject({
      method: "POST",
      url: "/auth/photo",
      headers: { cookie: `oneaboveall_session=${token}`, "content-type": contentType },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    const [row] = await db.select({ photoPath: users.photoPath }).from(users).where(eq(users.id, user.id));
    expect(row.photoPath).toBeNull();
  });

  it("re-uploading under a different extension removes the previous file", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-photo-3", email: "c@example.com", name: "C" }).returning();
    const { token } = await createSession(user.id);
    const app = buildServer();

    const first = buildMultipartBody({ filename: "a.jpg", contentType: "image/jpeg", content: Buffer.from("jpeg-bytes") });
    await app.inject({ method: "POST", url: "/auth/photo", headers: { cookie: `oneaboveall_session=${token}`, "content-type": first.contentType }, payload: first.body });
    const jpgPath = path.join(UPLOAD_DIR, `${user.id}.jpg`);
    expect(existsSync(jpgPath)).toBe(true);

    const second = buildMultipartBody({ filename: "a.png", contentType: "image/png", content: Buffer.from("png-bytes") });
    const response = await app.inject({ method: "POST", url: "/auth/photo", headers: { cookie: `oneaboveall_session=${token}`, "content-type": second.contentType }, payload: second.body });
    expect(response.statusCode).toBe(200);

    const pngPath = path.join(UPLOAD_DIR, `${user.id}.png`);
    expect(existsSync(pngPath)).toBe(true);
    expect(existsSync(jpgPath)).toBe(false);

    await unlink(pngPath).catch(() => {});
  });
});

// Owner-only since launch readiness (spec §5): the public scene shows the
// composed scene.jpg, never a raw upload, and the operator fetches a
// winner's photo through the bearer-token admin route instead.
describe("GET /photos/:userId", () => {
  async function userWithSession(providerId: string) {
    const [user] = await db.insert(users).values({ provider: "google", providerId, email: `${providerId}@example.com`, name: providerId }).returning();
    const { token } = await createSession(user.id);
    return { user, cookie: `oneaboveall_session=${token}` };
  }

  it("returns 401 with no session, even for a user who has a photo", async () => {
    const { user } = await userWithSession("g-photo-3");
    await db.update(users).set({ photoPath: `${user.id}.jpg` }).where(eq(users.id, user.id));
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: `/photos/${user.id}` });
    expect(response.statusCode).toBe(401);
  });

  it("returns 404 when the owner has no uploaded photo", async () => {
    const { user, cookie } = await userWithSession("g-photo-4");
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: `/photos/${user.id}`, headers: { cookie } });
    expect(response.statusCode).toBe(404);
  });

  // 404, not 403: a different signed-in user must not even learn whether
  // that id has a photo (or exists).
  it("returns 404 for someone else's photo, indistinguishable from no photo", async () => {
    const { user: owner } = await userWithSession("g-photo-6");
    await db.update(users).set({ photoPath: `${owner.id}.jpg` }).where(eq(users.id, owner.id));
    const { cookie: otherCookie } = await userWithSession("g-photo-7");

    const app = buildServer();
    const mine = await app.inject({ method: "GET", url: `/photos/${owner.id}`, headers: { cookie: otherCookie } });
    const nobody = await app.inject({ method: "GET", url: "/photos/00000000-0000-4000-8000-000000000000", headers: { cookie: otherCookie } });
    expect(mine.statusCode).toBe(404);
    expect(nobody.statusCode).toBe(404);
    expect(mine.body).toBe(nobody.body);
  });

  it("serves the owner their own photo with the right content type, never publicly cacheable", async () => {
    const { user, cookie } = await userWithSession("g-photo-5");
    const app = buildServer();

    const { body, contentType } = buildMultipartBody({ filename: "a.png", contentType: "image/png", content: Buffer.from("png-bytes") });
    await app.inject({ method: "POST", url: "/auth/photo", headers: { cookie, "content-type": contentType }, payload: body });

    const response = await app.inject({ method: "GET", url: `/photos/${user.id}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toBe("png-bytes");

    await unlink(path.join(UPLOAD_DIR, `${user.id}.png`)).catch(() => {});
  });
});
