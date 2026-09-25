import type { FastifyInstance } from "fastify";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { db } from "engine/db/client";
import { users } from "engine/db/schema";
import { eq } from "drizzle-orm";
import { requireSession } from "../auth/requireSession";

// Local disk for now — deliberately, not S3/R2: this is the fast path to a
// working upload while the site is still local-only. A real deployment
// needs a durable store instead (a container filesystem doesn't survive a
// redeploy), tracked as a follow-up, not solved here.
const UPLOAD_DIR = path.join(process.cwd(), "uploads");

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const EXT_TO_MIME = Object.fromEntries(Object.entries(MIME_TO_EXT).map(([mime, ext]) => [ext, mime]));

// Matches the old mock copy's own stated limit ("up to 12 MB").
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

export function registerPhotoRoutes(app: FastifyInstance): void {
  app.post("/auth/photo", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;

    const data = await request.file({ limits: { fileSize: MAX_PHOTO_BYTES } });
    if (!data) {
      reply.code(400);
      return { error: "no file uploaded" };
    }

    const ext = MIME_TO_EXT[data.mimetype];
    if (!ext) {
      reply.code(400);
      return { error: "only JPEG, PNG, or WebP images are accepted" };
    }

    await mkdir(UPLOAD_DIR, { recursive: true });

    // Clears any previous upload under a *different* extension (e.g.
    // re-uploading a .png after an earlier .jpg) — otherwise both would sit
    // on disk and only the one the DB row currently names would ever be
    // served, silently orphaning the other forever.
    await Promise.all(
      Object.values(MIME_TO_EXT)
        .filter((otherExt) => otherExt !== ext)
        .map((otherExt) => unlink(path.join(UPLOAD_DIR, `${user.id}.${otherExt}`)).catch(() => {})),
    );

    const filename = `${user.id}.${ext}`;
    const filePath = path.join(UPLOAD_DIR, filename);
    try {
      await pipeline(data.file, createWriteStream(filePath));
    } catch (err) {
      request.log.error({ err }, "photo upload: failed to write file to disk");
      reply.code(500);
      return { error: "failed to save the photo" };
    }

    // busboy (the multipart parser @fastify/multipart wraps) truncates the
    // stream rather than throwing when a file exceeds `limits.fileSize` —
    // the write above "succeeds" on a partial file, so this has to be
    // checked explicitly afterward, not inferred from the absence of an
    // error.
    if (data.file.truncated) {
      await unlink(filePath).catch(() => {});
      reply.code(413);
      return { error: "photo must be under 12 MB" };
    }

    await db.update(users).set({ photoPath: filename }).where(eq(users.id, user.id));
    return { photoPath: filename };
  });

  // Public — a round's champion is meant to be shown on the homepage, so
  // this can't require a session. Nothing sensitive is exposed: the file
  // itself is a photo the user explicitly uploaded to be shown publicly,
  // and the path is a server-assigned `<userId>.<ext>`, never derived from
  // request input beyond the id used to look it up.
  app.get<{ Params: { userId: string } }>("/photos/:userId", async (request, reply) => {
    const [row] = await db.select({ photoPath: users.photoPath }).from(users).where(eq(users.id, request.params.userId)).limit(1);
    if (!row?.photoPath) {
      reply.code(404);
      return { error: "no photo" };
    }
    const ext = row.photoPath.split(".").pop() ?? "";
    reply.type(EXT_TO_MIME[ext] ?? "application/octet-stream");
    return reply.send(createReadStream(path.join(UPLOAD_DIR, row.photoPath)));
  });
}
