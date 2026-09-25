#!/usr/bin/env node
// Builds apps/web's static site and atomically publishes it into the shared
// volume nginx serves from (see infra/k8s/web.yaml). This image is used two
// ways from the same entrypoint:
//
//   - as an initContainer, run once with --once, to populate the volume
//     before the nginx container ever starts serving;
//   - as a long-running sidecar exposing POST /rebuild, which apps/api
//     calls (see apps/api/src/scheduler.ts's onLeaderInstalled hook) the
//     moment a bidding window closes and installs a new champion — without
//     this, the champion's photo/name baked into index.html at image-build
//     time would go stale until the next full deploy.
//
// Runs `npm run build` (astro build) rather than reaching into Astro's API
// directly — this is the exact same command a developer runs locally, so
// there is only one build path to keep working, not two.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, rm, symlink, rename, readdir } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

const APP_DIR = "/app/apps/web";
const SHARED_ROOT = process.env.SHARED_ROOT ?? "/shared";
const PORT = Number(process.env.REBUILD_PORT ?? 8080);

let building = false;

async function build() {
  if (building) {
    return { ok: false, reason: "already building" };
  }
  building = true;
  try {
    await execFileAsync("npm", ["run", "build"], { cwd: APP_DIR });

    // Blue-green publish: build into a uniquely named directory, then swap
    // a `current` symlink to point at it with one atomic rename. nginx's
    // docroot is SHARED_ROOT/current, so it never observes a half-written
    // directory, whichever instant its next request lands in.
    const buildId = Date.now().toString();
    const target = path.join(SHARED_ROOT, `build-${buildId}`);
    await cp(path.join(APP_DIR, "dist"), target, { recursive: true });

    const tmpLink = path.join(SHARED_ROOT, `current.tmp-${buildId}`);
    await rm(tmpLink, { force: true });
    await symlink(target, tmpLink);
    await rename(tmpLink, path.join(SHARED_ROOT, "current"));

    await cleanupOldBuilds(buildId);
    return { ok: true, buildId };
  } finally {
    building = false;
  }
}

async function cleanupOldBuilds(currentBuildId) {
  const entries = await readdir(SHARED_ROOT);
  await Promise.all(
    entries
      .filter((name) => name.startsWith("build-") && name !== `build-${currentBuildId}`)
      .map((name) => rm(path.join(SHARED_ROOT, name), { recursive: true, force: true })),
  );
}

if (process.argv.includes("--once")) {
  const result = await build();
  if (!result.ok) {
    console.error("initial build failed:", result);
    process.exit(1);
  }
  console.log("initial build published:", result);
  process.exit(0);
}

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/rebuild") {
    try {
      const result = await build();
      res.writeHead(result.ok ? 200 : 409, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error("rebuild failed:", err);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
    return;
  }
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200);
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`web rebuilder listening on :${PORT}`);
});
