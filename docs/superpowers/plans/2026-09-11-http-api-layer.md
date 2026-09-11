# HTTP API Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the auction engine's two read-only queries (`getScene`, `getLeaderboard`) over HTTP as a new `apps/api` workspace, and switch `apps/web`'s public page from static mock data to a build-time fetch of real data from that API — the first end-to-end path from real Postgres data to the rendered page.

**Architecture:** `apps/api` is a thin Fastify HTTP layer with no domain logic of its own — it imports `apps/engine`'s existing query functions directly (via a workspace subpath export, TS-native, no build step) and serializes their results to JSON. `apps/web` fetches from this API inside its Astro frontmatter (which runs at *build* time, not in the browser), so the published page stays fully static per [public-page-delivery-design.md](../specs/2026-08-06-public-page-delivery-design.md) — there's still no live/dynamic endpoint the browser ever talks to. If the API is unreachable at build time (e.g. no local Postgres running), the build falls back to the existing mock data with a warning, so `apps/web` keeps working standalone for anyone who hasn't set up the engine's database.

**Tech Stack:** Fastify, TypeScript, `tsx` (TS-native dev runtime, already a transitive dependency in this monorepo), Vitest + Fastify's `.inject()` test helper (no real network needed for tests).

## Global Constraints

- No live/dynamic endpoint reachable from the *browser* — the fetch to `apps/api` happens only inside Astro's build-time frontmatter, never in client-side JS. Matches [public-page-delivery-design.md](../specs/2026-08-06-public-page-delivery-design.md)'s "fully static, no live endpoint" principle.
- Retinue = last 8 champions by chronology, most recent first — already implemented correctly by `getScene()`; this plan only transports that data, it doesn't re-derive it.
- Money stays in integer cents end-to-end — `apps/engine`'s query functions already return `priceCents`/`totalSpentCents` in cents; the API must not convert to dollars, and `apps/web`'s existing `formatMoney` (which divides by 100) stays the single place that conversion happens.
- **Known data-shape gap, to be handled explicitly, not silently:** `apps/engine`'s `getScene()`/`getLeaderboard()` have no `name` or `instagramUrl` fields (no user-profile system exists yet — that's tied to the not-yet-built auth subsystem) and return a nullable `champion` and raw millisecond durations, while `apps/web`'s mock `Person`/`LeaderboardRow` types assume a non-null champion, a `name` string, and a pre-formatted duration label. This plan's adapter layer must reconcile that explicitly (fall back to `occupantId` as the display name, format durations client-data-side, handle a null champion) rather than typing around it with `any`.

---

## File Structure

```
apps/engine/
  package.json                    # gains an "exports" map (Task 1)
apps/api/
  package.json, tsconfig.json, vitest.config.ts, .env.example
  src/
    server.ts                      # buildServer(): Fastify instance + routes, exported for tests
    index.ts                        # entrypoint: buildServer().listen(...)
    routes/scene.ts                  # GET /scene
    routes/leaderboard.ts             # GET /leaderboard
  tests/
    scene.test.ts
    leaderboard.test.ts
apps/web/
  src/lib/
    apiTypes.ts                     # types matching the API's actual JSON wire shape
    sceneAdapter.ts                   # apiTypes -> apps/web's existing Scene/Person/LeaderboardRow types
  src/pages/
    index.astro                     # modified: fetch real data at build time, fall back to mock on failure
  tests/
    sceneAdapter.test.ts
```

---

### Task 1: Export engine queries as a workspace subpath

**Files:**
- Modify: `apps/engine/package.json`

**Interfaces:**
- Produces: `apps/engine` becomes importable from a sibling workspace as `import { getScene, getLeaderboard } from "engine/queries/publicScene"`, resolving to `apps/engine/src/queries/publicScene.ts` directly (no build/dist step — the consumer must run under a TS-native runtime, which Task 2 sets up).

- [ ] **Step 1: Add an `exports` map to `apps/engine/package.json`**

Open `apps/engine/package.json` and add an `"exports"` field (keep every existing field — `name`, `private`, `type`, `scripts`, `dependencies`, `devDependencies` — unchanged):

```json
"exports": {
  "./*": "./src/*.ts"
}
```

- [ ] **Step 2: Verify the engine's own tests still pass unaffected**

Run: `npm test --workspace=apps/engine`
Expected: 73/73 still pass — this change only adds metadata, it doesn't touch any source file.

- [ ] **Step 3: Commit**

```bash
git add apps/engine/package.json
git commit -m "feat: export engine queries as a workspace subpath"
```

---

### Task 2: Scaffold `apps/api`

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/vitest.config.ts`, `apps/api/.env.example`, `apps/api/.gitignore`, `apps/api/src/server.ts`, `apps/api/src/index.ts`

**Interfaces:**
- Produces: `buildServer(): FastifyInstance` (exported from `apps/api/src/server.ts`) — an unstarted Fastify instance with no routes yet (Tasks 3-4 add them), usable directly in tests via `.inject()` without binding a real port.

- [ ] **Step 1: Create `apps/api/package.json`**

```json
{
  "name": "api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "engine": "*",
    "fastify": "^4.28.1",
    "dotenv": "^17.4.2"
  },
  "devDependencies": {
    "@types/node": "^22.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  }
}
```

If any exact version is no longer resolvable when you run `npm install`, bump only the failing package to its nearest current major-compatible release.

- [ ] **Step 2: Create `apps/api/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist"
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `apps/api/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15000,
  },
});
```

- [ ] **Step 4: Create `apps/api/.env.example`**

```
DATABASE_URL=postgres://auction:auction@localhost:5433/auction_engine_test
PORT=3001
```

(Same `DATABASE_URL` as `apps/engine/.env.example` — this API talks to the same Postgres database, it doesn't own a separate one.)

- [ ] **Step 5: Create `apps/api/.gitignore`**

```
node_modules
dist
.env
```

- [ ] **Step 6: Create `apps/api/src/server.ts`**

```ts
import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  return app;
}
```

- [ ] **Step 7: Create `apps/api/src/index.ts`**

```ts
import { buildServer } from "./server";

const app = buildServer();
const port = Number(process.env.PORT ?? 3001);

app.listen({ port, host: "127.0.0.1" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
```

- [ ] **Step 8: Install, typecheck, and smoke-test the empty server**

```bash
npm install
npm run typecheck --workspace=apps/api
cp apps/api/.env.example apps/api/.env
npm run start --workspace=apps/api &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/
kill %1
```

Expected: typecheck clean; the curl returns `404` (Fastify's default for an unregistered route — this confirms the server actually boots and accepts connections; a real `200` route comes in Task 3).

- [ ] **Step 9: Commit**

```bash
git add apps/api
git commit -m "chore: scaffold apps/api with Fastify"
```

---

### Task 3: `GET /scene` endpoint

**Files:**
- Create: `apps/api/src/routes/scene.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/tests/scene.test.ts`

**Interfaces:**
- Consumes: `getScene` from `engine/queries/publicScene` (Task 1's export map).
- Produces: `GET /scene` → `200` with a JSON body of exactly the shape `getScene()` returns (`{ champion: {occupantId, priceCents, since} | null, retinue: {occupantId, priceCents, startedAt, endedAt}[] }`), with `since`/`startedAt`/`endedAt` serialized as ISO 8601 strings (Fastify's default `JSON.stringify` on `Date` objects already does this — no manual formatting needed).
- Also registers `registerSceneRoute(app: FastifyInstance): void`, called from `server.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/scene.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

vi.mock("engine/queries/publicScene", () => ({
  getScene: vi.fn(async () => ({
    champion: { occupantId: "champ-1", priceCents: 421_000, since: new Date("2026-08-09T10:20:00.000Z") },
    retinue: [
      { occupantId: "retinue-1", priceCents: 398_000, startedAt: new Date("2026-08-08T00:00:00.000Z"), endedAt: new Date("2026-08-09T00:00:00.000Z") },
    ],
  })),
}));

describe("GET /scene", () => {
  it("returns the current scene as JSON", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/scene" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.champion.occupantId).toBe("champ-1");
    expect(body.champion.priceCents).toBe(421_000);
    expect(body.champion.since).toBe("2026-08-09T10:20:00.000Z");
    expect(body.retinue).toHaveLength(1);
    expect(body.retinue[0].occupantId).toBe("retinue-1");
  });

  it("returns a null champion as null, not omitted", async () => {
    const { getScene } = await import("engine/queries/publicScene");
    vi.mocked(getScene).mockResolvedValueOnce({ champion: null, retinue: [] });

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/scene" });

    expect(response.statusCode).toBe(200);
    expect(response.json().champion).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scene.test.ts` (from `apps/api`)
Expected: FAIL — `/scene` route doesn't exist, 404.

- [ ] **Step 3: Write `apps/api/src/routes/scene.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { getScene } from "engine/queries/publicScene";

export function registerSceneRoute(app: FastifyInstance): void {
  app.get("/scene", async () => {
    return getScene(new Date());
  });
}
```

- [ ] **Step 4: Wire it into `apps/api/src/server.ts`**

```ts
import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";
import { registerSceneRoute } from "./routes/scene";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  registerSceneRoute(app);
  return app;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/scene.test.ts`
Expected: PASS — 2 tests passed.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/scene.ts apps/api/src/server.ts apps/api/tests/scene.test.ts
git commit -m "feat: add GET /scene endpoint"
```

---

### Task 4: `GET /leaderboard` endpoint

**Files:**
- Create: `apps/api/src/routes/leaderboard.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/tests/leaderboard.test.ts`

**Interfaces:**
- Consumes: `getLeaderboard` from `engine/queries/publicScene` (Task 1's export map).
- Produces: `GET /leaderboard` → `200` with a JSON array of exactly the shape `getLeaderboard()` returns (`{occupantId, rounds, totalSpentCents, totalDurationMs}[]`, already sorted by `totalDurationMs` descending). Also registers `registerLeaderboardRoute(app: FastifyInstance): void`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/leaderboard.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

vi.mock("engine/queries/publicScene", () => ({
  getScene: vi.fn(async () => ({ champion: null, retinue: [] })),
  getLeaderboard: vi.fn(async () => [
    { occupantId: "alice", rounds: 6, totalSpentCents: 1_840_000, totalDurationMs: 950_400_000 },
    { occupantId: "bob", rounds: 2, totalSpentCents: 500_000, totalDurationMs: 172_800_000 },
  ]),
}));

describe("GET /leaderboard", () => {
  it("returns the leaderboard rows as JSON, in the order the engine returned them", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/leaderboard" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(2);
    expect(body[0].occupantId).toBe("alice");
    expect(body[0].totalDurationMs).toBe(950_400_000);
    expect(body[1].occupantId).toBe("bob");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/leaderboard.test.ts` (from `apps/api`)
Expected: FAIL — `/leaderboard` route doesn't exist, 404.

- [ ] **Step 3: Write `apps/api/src/routes/leaderboard.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { getLeaderboard } from "engine/queries/publicScene";

export function registerLeaderboardRoute(app: FastifyInstance): void {
  app.get("/leaderboard", async () => {
    return getLeaderboard();
  });
}
```

- [ ] **Step 4: Wire it into `apps/api/src/server.ts`**

Add the import and registration call alongside the scene route:

```ts
import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";
import { registerSceneRoute } from "./routes/scene";
import { registerLeaderboardRoute } from "./routes/leaderboard";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  registerSceneRoute(app);
  registerLeaderboardRoute(app);
  return app;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/leaderboard.test.ts`
Expected: PASS — 1 test passed.

- [ ] **Step 6: Run the full `apps/api` suite and typecheck**

Run: `npm run typecheck --workspace=apps/api && npm test --workspace=apps/api`
Expected: typecheck clean, 3 tests passed (2 scene + 1 leaderboard).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/leaderboard.ts apps/api/src/server.ts apps/api/tests/leaderboard.test.ts
git commit -m "feat: add GET /leaderboard endpoint"
```

---

### Task 5: `apps/web` adapter — real API shapes to existing UI types

**Files:**
- Create: `apps/web/src/lib/apiTypes.ts`, `apps/web/src/lib/sceneAdapter.ts`
- Test: `apps/web/tests/sceneAdapter.test.ts`

**Interfaces:**
- Consumes: `Scene`, `Person`, `LeaderboardRow` from `apps/web/src/lib/types.ts` (already exists, Task 4 of the frontend plan).
- Produces:
  - `apiTypes.ts`: `ApiSceneResponse = { champion: {occupantId: string; priceCents: number; since: string} | null; retinue: {occupantId: string; priceCents: number; startedAt: string; endedAt: string}[] }`, `ApiLeaderboardRow = { occupantId: string; rounds: number; totalSpentCents: number; totalDurationMs: number }` — matching the wire JSON exactly (dates as ISO strings, since JSON has no native `Date` type).
  - `sceneAdapter.ts`: `adaptScene(api: ApiSceneResponse): Scene | null` (returns `null` if `api.champion` is `null` — **there is no meaningful scene to render without a champion**, and the caller (Task 6) is responsible for falling back to something sensible in that case, not this function), `adaptLeaderboardRow(api: ApiLeaderboardRow): LeaderboardRow`, `formatDurationLabel(ms: number): string` (e.g. `950_400_000` → `"11d"`, matching the style of the existing mock data's `heldLabel`/`totalDurationLabel` strings — whole days, rounding down, no hours component, since that's what every existing mock value looks like).
  - **Documented gap-filling, not silently typed around:** since the API has no `name`/`instagramUrl` fields, `adaptScene`/`adaptLeaderboardRow` set `name: apiPerson.occupantId` (the ID doubles as the display name until a real profile system exists) and leave `instagramUrl` undefined.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/tests/sceneAdapter.test.ts
import { describe, it, expect } from "vitest";
import { adaptScene, adaptLeaderboardRow, formatDurationLabel } from "../src/lib/sceneAdapter";
import type { ApiSceneResponse, ApiLeaderboardRow } from "../src/lib/apiTypes";

describe("formatDurationLabel", () => {
  it("formats whole days, rounding down", () => {
    expect(formatDurationLabel(950_400_000)).toBe("11d"); // 11 days exactly
    expect(formatDurationLabel(100_800_000)).toBe("1d"); // 28h -> 1 full day
  });

  it("floors to 0d for anything under a day", () => {
    expect(formatDurationLabel(3_600_000)).toBe("0d");
  });
});

describe("adaptScene", () => {
  it("maps a populated scene, using occupantId as the display name", () => {
    const api: ApiSceneResponse = {
      champion: { occupantId: "mark-vilensky", priceCents: 421_000, since: "2026-08-09T10:20:00.000Z" },
      retinue: [
        { occupantId: "daniel-crowe", priceCents: 398_000, startedAt: "2026-08-08T00:00:00.000Z", endedAt: "2026-08-09T00:00:00.000Z" },
      ],
    };

    const scene = adaptScene(api);

    expect(scene).not.toBeNull();
    expect(scene!.champion.occupantId).toBe("mark-vilensky");
    expect(scene!.champion.name).toBe("mark-vilensky");
    expect(scene!.champion.priceCents).toBe(421_000);
    expect(scene!.champion.since).toEqual(new Date("2026-08-09T10:20:00.000Z"));
    expect(scene!.retinue).toHaveLength(1);
    expect(scene!.retinue[0].heldLabel).toBe("1d");
  });

  it("returns null when there is no champion", () => {
    expect(adaptScene({ champion: null, retinue: [] })).toBeNull();
  });
});

describe("adaptLeaderboardRow", () => {
  it("maps an API row, formatting the duration and defaulting the name to occupantId", () => {
    const api: ApiLeaderboardRow = { occupantId: "alice", rounds: 6, totalSpentCents: 1_840_000, totalDurationMs: 950_400_000 };
    const row = adaptLeaderboardRow(api);

    expect(row.occupantId).toBe("alice");
    expect(row.name).toBe("alice");
    expect(row.rounds).toBe(6);
    expect(row.totalSpentCents).toBe(1_840_000);
    expect(row.totalDurationLabel).toBe("11d");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sceneAdapter.test.ts` (from `apps/web`)
Expected: FAIL — cannot find module `../src/lib/sceneAdapter` / `../src/lib/apiTypes`.

- [ ] **Step 3: Write `apps/web/src/lib/apiTypes.ts`**

```ts
export interface ApiPerson {
  occupantId: string;
  priceCents: number;
  since: string;
}

export interface ApiRetinueMember {
  occupantId: string;
  priceCents: number;
  startedAt: string;
  endedAt: string;
}

export interface ApiSceneResponse {
  champion: ApiPerson | null;
  retinue: ApiRetinueMember[];
}

export interface ApiLeaderboardRow {
  occupantId: string;
  rounds: number;
  totalSpentCents: number;
  totalDurationMs: number;
}
```

- [ ] **Step 4: Write `apps/web/src/lib/sceneAdapter.ts`**

```ts
import type { Scene, Person, LeaderboardRow } from "./types";
import type { ApiSceneResponse, ApiRetinueMember, ApiLeaderboardRow } from "./apiTypes";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function formatDurationLabel(ms: number): string {
  return `${Math.floor(ms / MS_PER_DAY)}d`;
}

function adaptRetinueMember(api: ApiRetinueMember): Person {
  return {
    occupantId: api.occupantId,
    name: api.occupantId,
    priceCents: api.priceCents,
    since: new Date(api.startedAt),
    heldLabel: formatDurationLabel(new Date(api.endedAt).getTime() - new Date(api.startedAt).getTime()),
  };
}

export function adaptScene(api: ApiSceneResponse): Scene | null {
  if (!api.champion) return null;

  return {
    champion: {
      occupantId: api.champion.occupantId,
      name: api.champion.occupantId,
      priceCents: api.champion.priceCents,
      since: new Date(api.champion.since),
      heldLabel: "",
    },
    retinue: api.retinue.map(adaptRetinueMember),
  };
}

export function adaptLeaderboardRow(api: ApiLeaderboardRow): LeaderboardRow {
  return {
    occupantId: api.occupantId,
    name: api.occupantId,
    rounds: api.rounds,
    totalSpentCents: api.totalSpentCents,
    totalDurationLabel: formatDurationLabel(api.totalDurationMs),
  };
}
```

(`champion.heldLabel: ""` mirrors the existing mock data's convention from `apps/web/src/lib/types.ts`'s `Person.heldLabel` doc comment: "Unused for the champion" — the champion's held time is computed live client-side from `since`, never from a baked label.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/sceneAdapter.test.ts`
Expected: PASS — 6 tests passed.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/apiTypes.ts apps/web/src/lib/sceneAdapter.ts apps/web/tests/sceneAdapter.test.ts
git commit -m "feat: add adapter from real API shapes to existing UI types"
```

---

### Task 6: Wire `index.astro` to fetch real data at build time, with a mock fallback

**Files:**
- Modify: `apps/web/src/pages/index.astro`
- Create: `apps/web/.env.example`

**Interfaces:**
- Consumes: `adaptScene`, `adaptLeaderboardRow` (Task 5), `mockScene`, `mockLeaderboard` (existing, `apps/web/src/lib/mockData.ts` — kept as the fallback, not deleted).

- [ ] **Step 1: Create `apps/web/.env.example`**

```
API_BASE_URL=http://127.0.0.1:3001
```

- [ ] **Step 2: Read the current `apps/web/src/pages/index.astro`**

Note its existing imports of `mockScene`/`mockLeaderboard` (if `AuctionFlow` currently reads `mockLeaderboard` itself rather than receiving it as a prop — check `apps/web/src/components/AuctionFlow.tsx`'s actual current signature before assuming; adjust the prop-passing below to match whatever it actually expects).

- [ ] **Step 3: Rewrite the frontmatter to fetch at build time, falling back to mock data on any failure**

```astro
---
import BaseLayout from "../layouts/BaseLayout.astro";
import Scene from "../components/Scene.astro";
import AuctionFlow from "../components/AuctionFlow";
import { adaptScene, adaptLeaderboardRow } from "../lib/sceneAdapter";
import { mockScene, mockLeaderboard } from "../lib/mockData";
import type { Scene as SceneData, LeaderboardRow } from "../lib/types";

const apiBaseUrl = import.meta.env.API_BASE_URL ?? "http://127.0.0.1:3001";

let scene: SceneData = mockScene;
let leaderboard: LeaderboardRow[] = mockLeaderboard;

try {
  const [sceneRes, leaderboardRes] = await Promise.all([
    fetch(`${apiBaseUrl}/scene`),
    fetch(`${apiBaseUrl}/leaderboard`),
  ]);

  if (!sceneRes.ok || !leaderboardRes.ok) {
    throw new Error(`API responded with ${sceneRes.status}/${leaderboardRes.status}`);
  }

  const sceneJson = await sceneRes.json();
  const leaderboardJson = await leaderboardRes.json();
  const adaptedScene = adaptScene(sceneJson);

  if (adaptedScene) {
    scene = adaptedScene;
    leaderboard = leaderboardJson.map(adaptLeaderboardRow);
  } else {
    console.warn("[build] /scene returned no champion yet (engine not bootstrapped) — using mock data.");
  }
} catch (err) {
  console.warn(`[build] Could not reach the API at ${apiBaseUrl}, falling back to mock data:`, err instanceof Error ? err.message : err);
}
---
<BaseLayout title="oneabobeall">
  <Scene scene={scene} />
  <AuctionFlow client:idle />
</BaseLayout>
```

Check `AuctionFlow`'s actual props (per the note in Step 2) — if it currently imports `mockLeaderboard` internally rather than accepting a `leaderboard` prop, either add a `leaderboard?: LeaderboardRow[]` prop to `AuctionFlow.tsx` (defaulting to the existing `mockLeaderboard` import so nothing breaks if omitted) and pass `leaderboard={leaderboard}` here, or — if that's a bigger change than this task should make — leave `AuctionFlow`'s leaderboard on mock data for now and only wire `Scene`'s real data through, noting the leftover mock leaderboard explicitly in your task report as a follow-up. Prefer wiring it through if it's a small, mechanical prop addition; don't force it if `AuctionFlow`'s internals make it awkward.

- [ ] **Step 4: Verify the fallback path works (no API running)**

```bash
npm run build --workspace=apps/web
```

Expected: build succeeds, console shows the `[build] Could not reach the API...` warning (no API server is running at this point), and `apps/web/dist/index.html` renders using mock data — confirm by checking it still contains "Mark Vilensky" (the mock champion's name) or another mock-data-specific string.

- [ ] **Step 5: Verify the live path works (API running against real Postgres)**

This requires `apps/engine`'s database to be bootstrapped with at least one champion (`getScene()` returns a champion) — if it isn't, running this step will just re-exercise the fallback path, which is still useful to confirm but doesn't prove the live path. Check first:

```bash
cd apps/engine && npm run db:push
```

Then, in one terminal:

```bash
npm run start --workspace=apps/api &
```

In another:

```bash
npm run build --workspace=apps/web
```

If the engine's `reigns` table is empty (no champion bootstrapped yet — this is expected, since nothing in this plan or prior plans calls `createInitialReign`), the build will hit the "no champion yet" warning branch and use mock data — this is correct, expected behavior, not a bug. If you want to verify the fully-live path end-to-end, you can manually bootstrap one via a throwaway script (e.g. a one-off `node -e` or `tsx` invocation importing `createInitialReign` from `engine/engine/bootstrap` and calling it with a test occupant ID and the current date) — but don't commit that script or leave the database mutated in a way that would affect later work; treat it as a manual verification step, not part of the deliverable. Document in your report which of these two paths (fallback vs. genuinely live) you actually exercised.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/index.astro apps/web/.env.example
git commit -m "feat: fetch real scene/leaderboard data at build time with mock fallback"
```

---

## Self-Review Notes

- **Spec coverage:** read-only HTTP access to the engine's real data (Tasks 1-4), the static-build-time-fetch delivery model with no browser-visible live endpoint (Task 6, matches [public-page-delivery-design.md](../specs/2026-08-06-public-page-delivery-design.md)), the mock-vs-real type gap flagged by the frontend plan's final review — explicitly resolved here rather than deferred again (Task 5) — all covered.
- **Deferred to later plans, intentionally:** authenticated write endpoints (`POST /bids`, payment confirmation) — these need real bidder identity, which needs the auth subsystem first; a scheduler `tick()` trigger endpoint — needs a decision on deployment/cron strategy not yet made; `AuctionFlow`'s interactive bid/pay/upload flow staying on mock data — it exercises a hypothetical bidder's session, which has nothing to attach to until auth exists.
