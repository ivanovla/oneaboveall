import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "engine/db/client";
import { users } from "engine/db/schema";
import { getAdminRound, getAdminStats } from "engine/queries/admin";
import { deleteStoredPhotos, sendPhoto } from "./photo";

// Same shape check as roundParticipation.ts: users.id is a Postgres uuid, so
// a malformed id must be rejected before it reaches a query (where it would
// raise a cast error and surface as a 500).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Matches authMe.ts's PATCH /auth/name limit — the operator renaming
// someone is held to the same bar as the user renaming themselves.
const MAX_NAME_LENGTH = 80;

// Hashing both sides first gives timingSafeEqual two equal-length buffers
// no matter what the caller sent — it throws on a length mismatch, and
// branching on length first would itself leak the token's length.
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Gate for every /admin route: `Authorization: Bearer <ADMIN_TOKEN>`.
 *
 * ADMIN_TOKEN is read per request (not captured at boot) so tests — and an
 * operator rotating the secret plus restarting — see the current value.
 * When it's unset or empty the whole operator surface doesn't exist: every
 * /admin route answers Fastify's own stock 404, so a deployment that never
 * configured a token can't be brute-forced and doesn't even reveal that
 * these routes are there. A wrong or missing token gets a plain 401.
 */
async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const expected = process.env.ADMIN_TOKEN ?? "";
  if (expected === "") {
    reply.callNotFound();
    return reply;
  }
  const header = request.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (presented === "" || !timingSafeEqual(digest(presented), digest(expected))) {
    reply.code(401).send({ error: "unauthorized" });
    return reply;
  }
}

type PatchUserBody = {
  sponsored?: unknown;
  clearSocialUrl?: unknown;
  clearPhoto?: unknown;
  name?: unknown;
};

export function registerAdminRoutes(app: FastifyInstance): void {
  // Its own encapsulated plugin so the auth hook applies to exactly these
  // routes and nothing else on the server.
  app.register(async (admin) => {
    admin.addHook("onRequest", requireAdmin);

    // Funnel per streamer ref plus totals — see engine/queries/admin.ts.
    admin.get("/admin/stats", async () => getAdminStats());

    // The live round's leader and runner-up (the two holds still alive),
    // plus the reigning champion, with the contact details the operator
    // needs to reach a winner and compose their art.
    admin.get("/admin/round", async () => getAdminRound());

    // The raw upload, for composing the scene art. The public route
    // (GET /photos/:userId) is owner-only since launch readiness.
    admin.get<{ Params: { userId: string } }>("/admin/photos/:userId", async (request, reply) => {
      const { userId } = request.params;
      if (!UUID_RE.test(userId)) {
        reply.code(400);
        return { error: "invalid user id" };
      }
      const [row] = await db.select({ photoPath: users.photoPath }).from(users).where(eq(users.id, userId)).limit(1);
      if (!row?.photoPath) {
        reply.code(404);
        return { error: "no photo" };
      }
      reply.header("cache-control", "private, no-store");
      return sendPhoto(reply, row.photoPath);
    });

    // Moderation and sponsorship in one place: flag a creator as sponsored
    // (shown publicly as a "Sponsored" label), drop a bad social link or
    // photo, or replace an unacceptable display name. Every field is
    // optional, but the body must ask for at least one change.
    admin.patch<{ Params: { id: string }; Body: PatchUserBody }>("/admin/users/:id", async (request, reply) => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) {
        reply.code(400);
        return { error: "invalid user id" };
      }

      const body = request.body ?? {};
      const changes: Partial<typeof users.$inferInsert> = {};

      if (body.sponsored !== undefined) {
        if (typeof body.sponsored !== "boolean") {
          reply.code(400);
          return { error: "sponsored must be a boolean" };
        }
        changes.sponsored = body.sponsored;
      }
      if (body.clearSocialUrl !== undefined) {
        if (body.clearSocialUrl !== true) {
          reply.code(400);
          return { error: "clearSocialUrl must be true when present" };
        }
        changes.socialUrl = null;
      }
      if (body.clearPhoto !== undefined) {
        if (body.clearPhoto !== true) {
          reply.code(400);
          return { error: "clearPhoto must be true when present" };
        }
        // photoConsentAt is deliberately left alone: it records that consent
        // was once given for an upload that did exist, which stays true.
        changes.photoPath = null;
      }
      if (body.name !== undefined) {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name || name.length > MAX_NAME_LENGTH) {
          reply.code(400);
          return { error: `name must be between 1 and ${MAX_NAME_LENGTH} characters` };
        }
        changes.name = name;
      }

      if (Object.keys(changes).length === 0) {
        reply.code(400);
        return { error: "nothing to change — send sponsored, clearSocialUrl, clearPhoto and/or name" };
      }

      const [updated] = await db.update(users).set(changes).where(eq(users.id, id)).returning();
      if (!updated) {
        reply.code(404);
        return { error: "user not found" };
      }
      // DB first, file second: if the unlink fails the row already no longer
      // points at the file, so it can't be served or composed again.
      if (changes.photoPath === null) await deleteStoredPhotos(id);

      return {
        userId: updated.id,
        name: updated.name,
        email: updated.email,
        sponsored: updated.sponsored,
        socialUrl: updated.socialUrl,
        hasPhoto: !!updated.photoPath,
      };
    });
  });
}
