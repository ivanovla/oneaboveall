# Public Page Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the public generative page (the scene, hover stat cards, and the full auth→bid→queue→pay→upload→pending/missed flow plus the leaderboard overlay) as a real Astro + TypeScript app, matching [design/prototype/one-above-all.dc.html](../../../design/prototype/one-above-all.dc.html) pixel-for-pixel, running on typed mock data shaped exactly like the auction engine's real read queries.

**Architecture:** Astro (static output) for the page shell and the mostly-static scene, with one small interactive React island (`client:idle`) for the stepped modal flow — matching the "static page + islands only where needed" principle from [public-page-delivery-design.md](../specs/2026-08-06-public-page-delivery-design.md). No backend HTTP layer exists yet, so every screen runs on an in-repo mock data module whose shapes mirror `apps/engine/src/queries/publicScene.ts`'s real return types, so wiring the real API later is a data-source swap, not a rewrite. This plan first restructures the repo into an npm-workspaces monorepo (`apps/engine` + `apps/web`) since a second app can no longer live at the repo root.

**Tech Stack:** Astro (static build), TypeScript, React (island only), Vitest + @testing-library/react for the island's state machine, npm workspaces.

## Global Constraints

- The prototype ([design/prototype/one-above-all.dc.html](../../../design/prototype/one-above-all.dc.html)) is the canonical UX/visual reference per [ui-reference.md](../specs/2026-08-12-ui-reference.md) — every screen, copy string, and visual detail must match it unless a task here explicitly says otherwise.
- Color tokens (dark, default): `--void:#070603; --fg:#f0e7d6; --fg-dim:rgba(240,231,214,.56); --fg-faint:rgba(240,231,214,.3); --gold:#c9a45c; --gold-soft:rgba(201,164,92,.34); --panel:rgba(14,11,7,.86); --panel-2:rgba(255,250,240,.045); --line:rgba(201,164,92,.22); --scrim:rgba(5,4,2,.72); --btn-fg:#100c06; --on-scene:#f4ecdd; --on-scene-dim:rgba(244,236,221,.6); --on-scene-faint:rgba(244,236,221,.42); --scene-chip:rgba(12,9,5,.62)`.
- Color tokens (`[data-theme="light"]` override): `--void:#e9e2d5; --fg:#171310; --fg-dim:rgba(23,19,16,.62); --fg-faint:rgba(23,19,16,.34); --gold:#7d5c22; --gold-soft:rgba(125,92,34,.3); --panel:rgba(250,246,238,.9); --panel-2:rgba(23,19,16,.05); --line:rgba(125,92,34,.24); --scrim:rgba(238,232,221,.7); --btn-fg:#faf6ee`.
- Fonts: Cormorant Garamond (weights 300;400;500;600) for display/numbers, Manrope (300;400;500;600;700) for body/labels — both from Google Fonts, loaded exactly as the prototype's `<link>` tags do.
- The "Displace" button label is always English, regardless of surrounding copy language.
- Retinue = last 8 champions by chronology (most recent first) — mock data must reflect this ordering, matching [auction-engine-design.md](../specs/2026-08-06-auction-engine-design.md) and the already-implemented `getScene()` in `apps/engine/src/queries/publicScene.ts`.
- Deposit = 10% of the bid, capped at $1,000 — mock computed values must use this formula (same as `apps/engine/src/domain/deposit.ts`'s `calculateDeposit`).
- No live/dynamic endpoint for this phase — all data is static/mocked, matching the "fully static, no live endpoint" delivery model. Do not add a fetch/polling layer.

---

## File Structure

```
package.json                          # root: npm workspaces ["apps/*"]
apps/
  engine/                              # existing backend, moved here as-is (Task 1)
    ...(unchanged internals)
  web/
    package.json, astro.config.mjs, tsconfig.json
    src/
      styles/tokens.css                # design tokens from Global Constraints
      layouts/BaseLayout.astro         # html shell, fonts, theme toggle wiring
      lib/
        types.ts                       # Scene/Leaderboard/Person types, mirroring apps/engine's query shapes
        format.ts                      # money/countdown formatting helpers
        mockData.ts                    # typed sample data (9 people, 8-row leaderboard)
      components/
        Scene.astro                    # full-bleed image, 9 hotspots, hover cards (vanilla client script)
        AuctionFlow.tsx                # React island: Displace button + full modal state machine + leaderboard overlay
      pages/
        index.astro                    # renders Scene + mounts AuctionFlow island
    public/
      scene.png                        # copied from design/prototype/scene.png
    tests/
      format.test.ts
      AuctionFlow.test.tsx
```

---

### Task 1: Restructure into an npm workspaces monorepo

**Files:**
- Move: `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `drizzle.config.ts`, `docker-compose.yml`, `.env.example`, `src/`, `tests/` → same names under `apps/engine/`
- Create: root `package.json` (new, minimal workspaces manifest)
- Modify: `apps/engine/package.json` (add a `name` field)

**Interfaces:**
- Produces: an `apps/engine` workspace whose `npm test`/`npm run typecheck`/`npm run db:push` scripts behave identically to before, runnable either via `npm run <script> --workspace=apps/engine` from the repo root or via `cd apps/engine && npm run <script>`.

- [ ] **Step 1: Create the target directory and move every existing project file into it**

```bash
mkdir -p apps/engine
git mv package.json apps/engine/package.json
git mv package-lock.json apps/engine/package-lock.json
git mv tsconfig.json apps/engine/tsconfig.json
git mv vitest.config.ts apps/engine/vitest.config.ts
git mv drizzle.config.ts apps/engine/drizzle.config.ts
git mv docker-compose.yml apps/engine/docker-compose.yml
git mv .env.example apps/engine/.env.example
git mv src apps/engine/src
git mv tests apps/engine/tests
# .env is gitignored (untracked) — git mv won't touch it, move it directly if present:
[ -f .env ] && mv .env apps/engine/.env || true
```

- [ ] **Step 2: Add a `name` field to `apps/engine/package.json`**

Open `apps/engine/package.json` and add `"name": "engine",` as the first key (it currently starts `{"private": true, ...}` — keep everything else unchanged).

- [ ] **Step 3: Remove the now-redundant nested lockfile**

npm workspaces use a single root-level lockfile. Delete the one that just moved:

```bash
git rm apps/engine/package-lock.json
```

- [ ] **Step 4: Create the root `package.json`**

```json
{
  "name": "oneabobeall",
  "private": true,
  "workspaces": [
    "apps/*"
  ]
}
```

- [ ] **Step 5: Update `.gitignore` for the new layout**

Read the current root `.gitignore` first (it has evolved during this project — don't assume its contents). Ensure it still ignores `node_modules`, `dist`, `.env`, and `.worktrees/` regardless of which directory they appear in (e.g. `**/node_modules`, `**/.env`, `**/dist` patterns work whether they're at root or under `apps/*`). Add any pattern that's missing; keep everything already there.

- [ ] **Step 6: Install from the root and verify the engine still works**

```bash
npm install
docker compose -f apps/engine/docker-compose.yml up -d db
cp apps/engine/.env.example apps/engine/.env
sleep 2
npm run db:push --workspace=apps/engine
npm run typecheck --workspace=apps/engine
npm test --workspace=apps/engine
```

Expected: install succeeds with a single root `package-lock.json` created; typecheck clean; all 73 engine tests pass, unchanged in count and content — only their location moved.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: restructure into npm workspaces monorepo (apps/engine)"
```

---

### Task 2: Scaffold the Astro app

**Files:**
- Create: `apps/web/package.json`, `apps/web/astro.config.mjs`, `apps/web/tsconfig.json`, `apps/web/src/pages/index.astro`, `apps/web/.gitignore`

**Interfaces:**
- Produces: a working `apps/web` workspace with `npm run dev --workspace=apps/web` serving a page, and `npm run build --workspace=apps/web` producing a static `dist/`.

- [ ] **Step 1: Create `apps/web/package.json`**

```json
{
  "name": "web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
    "typecheck": "astro check",
    "test": "vitest run"
  },
  "dependencies": {
    "astro": "^4.15.0",
    "@astrojs/react": "^3.6.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.5.0",
    "jsdom": "^25.0.0",
    "vitest": "^2.0.5",
    "typescript": "^5.5.4"
  }
}
```

If any of these exact versions is no longer resolvable when you run `npm install` (this list was written ahead of time and package registries move), bump only the failing package to its nearest current major-compatible release — don't downgrade others to match.

- [ ] **Step 2: Create `apps/web/astro.config.mjs`**

```js
import { defineConfig } from "astro/config";
import react from "@astrojs/react";

export default defineConfig({
  output: "static",
  integrations: [react()],
});
```

- [ ] **Step 3: Create `apps/web/tsconfig.json`**

```json
{
  "extends": "astro/tsconfigs/strict",
  "include": [".astro/types.d.ts", "**/*", "tests/**/*"],
  "exclude": ["dist"]
}
```

- [ ] **Step 4: Create `apps/web/.gitignore`**

```
node_modules
dist
.astro
```

- [ ] **Step 5: Create a placeholder `apps/web/src/pages/index.astro`**

```astro
---
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>oneabobeall</title>
  </head>
  <body>
    <p>Scaffold OK</p>
  </body>
</html>
```

- [ ] **Step 6: Install and verify the dev server boots**

```bash
npm install
npm run build --workspace=apps/web
```

Expected: build succeeds and produces `apps/web/dist/index.html` containing "Scaffold OK".

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "chore: scaffold Astro + React app at apps/web"
```

---

### Task 3: Design tokens, fonts, and the base layout

**Files:**
- Create: `apps/web/src/styles/tokens.css`, `apps/web/src/layouts/BaseLayout.astro`
- Modify: `apps/web/src/pages/index.astro`

**Interfaces:**
- Produces: `BaseLayout.astro`, a `.astro` layout component accepting a `title: string` slot prop and wrapping page content in the theme-aware `<html>` shell. All later components rely on the CSS custom properties this task defines being present on `:root`/`[data-theme]`.

- [ ] **Step 1: Create `apps/web/src/styles/tokens.css`**

```css
:root {
  --void: #070603;
  --fg: #f0e7d6;
  --fg-dim: rgba(240, 231, 214, .56);
  --fg-faint: rgba(240, 231, 214, .3);
  --gold: #c9a45c;
  --gold-soft: rgba(201, 164, 92, .34);
  --panel: rgba(14, 11, 7, .86);
  --panel-2: rgba(255, 250, 240, .045);
  --line: rgba(201, 164, 92, .22);
  --scrim: rgba(5, 4, 2, .72);
  --btn-fg: #100c06;
  --on-scene: #f4ecdd;
  --on-scene-dim: rgba(244, 236, 221, .6);
  --on-scene-faint: rgba(244, 236, 221, .42);
  --scene-chip: rgba(12, 9, 5, .62);
}

[data-theme="light"] {
  --void: #e9e2d5;
  --fg: #171310;
  --fg-dim: rgba(23, 19, 16, .62);
  --fg-faint: rgba(23, 19, 16, .34);
  --gold: #7d5c22;
  --gold-soft: rgba(125, 92, 34, .3);
  --panel: rgba(250, 246, 238, .9);
  --panel-2: rgba(23, 19, 16, .05);
  --line: rgba(125, 92, 34, .24);
  --scrim: rgba(238, 232, 221, .7);
  --btn-fg: #faf6ee;
}

* { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
html, body { margin: 0; padding: 0; background: var(--void); font-family: Manrope, Helvetica, Arial, sans-serif; }
a { color: var(--gold); text-decoration: none; }
a:hover { color: var(--fg); }
button { font-family: inherit; cursor: pointer; border: 0; background: none; color: inherit; }
input { font-family: inherit; }

@keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes breathe { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }
```

- [ ] **Step 2: Create `apps/web/src/layouts/BaseLayout.astro`**

```astro
---
import "../styles/tokens.css";

interface Props {
  title: string;
}
const { title } = Astro.props;
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500;600&family=Manrope:wght@300;400;500;600;700&display=swap"
      rel="stylesheet"
    />
  </head>
  <body>
    <slot />
  </body>
</html>
```

- [ ] **Step 3: Wire `index.astro` to use the layout**

```astro
---
import BaseLayout from "../layouts/BaseLayout.astro";
---
<BaseLayout title="oneabobeall">
  <p>Layout OK</p>
</BaseLayout>
```

- [ ] **Step 4: Build and verify**

```bash
npm run build --workspace=apps/web
```

Expected: `apps/web/dist/index.html` contains the Google Fonts `<link>` tags and "Layout OK".

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat: add design tokens and base layout"
```

---

### Task 4: Types, formatting helpers, and mock data

**Files:**
- Create: `apps/web/src/lib/types.ts`, `apps/web/src/lib/format.ts`, `apps/web/src/lib/mockData.ts`
- Test: `apps/web/tests/format.test.ts`
- Create: `apps/web/vitest.config.ts`

**Interfaces:**
- Consumes: nothing new (pure TypeScript, no framework).
- Produces:
  - `types.ts`: `Person = { occupantId: string; name: string; priceCents: number; since: Date; heldLabel: string; instagramUrl?: string }`, `Scene = { champion: Person; retinue: Person[] }`, `LeaderboardRow = { occupantId: string; name: string; rounds: number; totalSpentCents: number; totalDurationLabel: string }`.
  - `format.ts`: `formatMoney(cents: number): string` (e.g. `4210_00` → `"$4,210"` — note: engine amounts are in cents, so divide by 100 before formatting, unlike the prototype's demo data which used whole dollars directly), `formatCountdown(msRemaining: number): string` (`"06:41:12"` style, clamped at 0), `calculateDepositDisplay(bidCents: number): number` (10% capped at $1,000, mirrors `apps/engine/src/domain/deposit.ts`).
  - `mockData.ts`: `mockScene: Scene` (9 people: 1 champion + 8 retinue, using the prototype's `PEOPLE` array as source data — read [design/prototype/one-above-all.dc.html](../../../design/prototype/one-above-all.dc.html)'s `PEOPLE`/`BOARD` JS arrays lines ~269-290 for the exact names/positions/stats to reuse), `mockLeaderboard: LeaderboardRow[]` (from the prototype's `BOARD` array), `mockCurrentPriceCents: number`, `mockBiddingWindowClosesAt: Date` (a fixed future timestamp relative to a build-time constant, not `Date.now()`).

- [ ] **Step 1: Create `apps/web/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
  },
});
```

- [ ] **Step 2: Create `apps/web/tests/setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 3: Write the failing test**

```ts
// apps/web/tests/format.test.ts
import { describe, it, expect } from "vitest";
import { formatMoney, formatCountdown, calculateDepositDisplay } from "../src/lib/format";

describe("formatMoney", () => {
  it("formats cents as a dollar string with thousands separators", () => {
    expect(formatMoney(421_000)).toBe("$4,210");
  });

  it("rounds to the nearest dollar", () => {
    expect(formatMoney(100_050)).toBe("$1,001"); // $1,000.50 rounds up
  });
});

describe("formatCountdown", () => {
  it("formats milliseconds as HH:MM:SS", () => {
    expect(formatCountdown((6 * 3600 + 41 * 60 + 12) * 1000)).toBe("06:41:12");
  });

  it("clamps negative remaining time to zero", () => {
    expect(formatCountdown(-5000)).toBe("00:00:00");
  });
});

describe("calculateDepositDisplay", () => {
  it("is 10% of the bid", () => {
    expect(calculateDepositDisplay(10_000)).toBe(1_000);
  });

  it("caps at $1,000 (100,000 cents)", () => {
    expect(calculateDepositDisplay(50_000_000)).toBe(100_000);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/format.test.ts` (from `apps/web`)
Expected: FAIL — cannot find module `../src/lib/format`.

- [ ] **Step 5: Write `apps/web/src/lib/format.ts`**

```ts
const DEPOSIT_PERCENT = 0.10;
const DEPOSIT_CAP_CENTS = 100_000;

export function formatMoney(cents: number): string {
  return "$" + Math.round(cents / 100).toLocaleString("en-US");
}

export function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function calculateDepositDisplay(bidCents: number): number {
  return Math.min(DEPOSIT_CAP_CENTS, Math.round(bidCents * DEPOSIT_PERCENT));
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/format.test.ts`
Expected: PASS — 6 tests passed.

- [ ] **Step 7: Create `apps/web/src/lib/types.ts`**

```ts
export interface Person {
  occupantId: string;
  name: string;
  priceCents: number;
  // Reign start. For the champion, "time held so far" is computed client-side
  // as `now - since` (it keeps ticking up) — never baked in as a static string.
  // For a retinue member, since is still stored for the "since"/period line,
  // but their held-duration is over and reported via heldLabel instead.
  since: Date;
  // Fixed "1d 4h"-style duration string for a retinue member, whose reign has
  // already ended — never recomputed. Unused for the champion.
  heldLabel: string;
  instagramUrl?: string;
}

export interface Scene {
  champion: Person;
  retinue: Person[];
}

export interface LeaderboardRow {
  occupantId: string;
  name: string;
  rounds: number;
  totalSpentCents: number;
  totalDurationLabel: string;
}
```

- [ ] **Step 8: Create `apps/web/src/lib/mockData.ts`**

Read [design/prototype/one-above-all.dc.html](../../../design/prototype/one-above-all.dc.html)'s `PEOPLE` array (defines name, position-on-scene as `left`/`top` percentages, rank label, period text, held/paid stats, Instagram link — one entry is the champion at `left:50.4, top:18.4`, the other 8 are the retinue) and its `BOARD` array (leaderboard rows: rank, name, rounds, spent, days). Transcribe these into typed mock data — same names and numbers, reshaped to this task's `Person`/`LeaderboardRow`/`Scene` types (money values become cents, e.g. the prototype's `paid:"$4,210"` becomes `priceCents: 421_000`; `held:"1d 4h"` becomes a `since: Date` computed as `now - (1 day 4 hours)` using a fixed reference date, not live `Date.now()` — pick a fixed constant date like `new Date("2026-08-09T14:20:00Z")` as "now" for all mock computations, so the build is deterministic).

Export:
```ts
export const mockScene: Scene = { champion: /* ... */, retinue: [/* 8 entries, most-recent-first */] };
export const mockLeaderboard: LeaderboardRow[] = [/* 8 entries from BOARD */];
export const mockCurrentPriceCents = 421_000; // matches the champion's priceCents
export const mockBiddingWindowClosesAt = new Date("2026-08-09T21:01:12Z"); // matches the prototype's demo countdown of ~6h41m from its reference "now"
```

- [ ] **Step 9: Commit**

```bash
git add apps/web
git commit -m "feat: add types, formatting helpers, and mock scene/leaderboard data"
```

---

### Task 5: Static scene component (image, hotspots, hover cards)

**Files:**
- Create: `apps/web/src/components/Scene.astro`
- Copy: `design/prototype/scene.png` → `apps/web/public/scene.png`

**Interfaces:**
- Consumes: `Scene`, `Person` types and `mockScene` (Task 4).
- Produces: a `Scene.astro` component accepting a `scene: Scene` prop, rendering the full-bleed image with 9 invisible hotspots positioned by percentage and hover/tap tooltip cards. No client framework — plain inline `<script>` for hover state, matching the "site should open instantly" principle (this component ships zero JS framework bytes).

- [ ] **Step 1: Copy the reference image**

```bash
cp design/prototype/scene.png apps/web/public/scene.png
```

- [ ] **Step 2: Create `apps/web/src/components/Scene.astro`**

Read the prototype's scene markup (the `<sc-for list="{{ people }}">` and `<sc-for list="{{ tips }}">` blocks, roughly lines 45-76 of [one-above-all.dc.html](../../../design/prototype/one-above-all.dc.html)) for the exact layout: a `position: absolute` container sized to `16/9` aspect ratio centered on screen, the image with `object-fit: cover`, a radial-gradient vignette overlay, then one `<button>` per person as an invisible circular hotspot (`5.4vw` diameter, `min-width/height: 44px`) positioned at that person's `left%`/`top%`, and a tooltip card that appears near the hovered person's position (clamped horizontally to `14%`-`86%`, offset `+5%` down from the hovered dot) showing name, rank, period, a Held/Paid two-column stat block, and an Instagram link.

Implement this as a `.astro` component using the `Scene: { scene: Scene }` prop for data, with a `<script>` tag (runs client-side, no framework) that:
- Reads `data-left`/`data-top`/`data-name`/etc. attributes off each hotspot button (set server-side from the `scene` prop during Astro's render).
- On `mouseenter`/`focus` of a hotspot (and `click` for touch), shows a single tooltip element, repositioned and repopulated with that person's data.
- On `mouseleave`/`blur`, hides it.

Match the prototype's exact CSS values (dimensions, blur, box-shadow, font sizes, letter-spacing) from the same markup block — copy them directly rather than approximating.

- [ ] **Step 3: Use it in `index.astro`**

```astro
---
import BaseLayout from "../layouts/BaseLayout.astro";
import Scene from "../components/Scene.astro";
import { mockScene } from "../lib/mockData";
---
<BaseLayout title="oneabobeall">
  <Scene scene={mockScene} />
</BaseLayout>
```

- [ ] **Step 4: Build and visually verify**

```bash
npm run build --workspace=apps/web
npm run preview --workspace=apps/web
```

Open the preview URL in a browser (use the Browser tool if available in your environment) and confirm: the scene image fills the viewport, hovering each of the 9 dots shows the correct tooltip with correct name/stats, and the layout doesn't visibly diverge from the prototype when opened side-by-side.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat: add static scene component with hover stat cards"
```

---

### Task 6: AuctionFlow island — state machine skeleton (auth → bid → lead)

**Files:**
- Create: `apps/web/src/components/AuctionFlow.tsx`
- Test: `apps/web/tests/AuctionFlow.test.tsx`

**Interfaces:**
- Consumes: `formatMoney`, `formatCountdown`, `calculateDepositDisplay` (Task 4), `mockCurrentPriceCents`, `mockBiddingWindowClosesAt` (Task 4).
- Produces: `AuctionFlow`, a React component with no required props (self-contained), rendering the price/"Displace" button footer chrome plus a step-driven modal overlay. Internal screen states: `"closed" | "auth" | "bid" | "lead" | "pay" | "upload" | "pending" | "missed" | "top"`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/tests/AuctionFlow.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AuctionFlow from "../src/components/AuctionFlow";

describe("AuctionFlow", () => {
  it("shows the current price and Displace button on the closed screen", () => {
    render(<AuctionFlow />);
    expect(screen.getByText("Displace")).toBeInTheDocument();
    expect(screen.getByText("$4,210")).toBeInTheDocument();
  });

  it("opens the auth screen when Displace is clicked", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    expect(screen.getByText("Sign in to claim the seat")).toBeInTheDocument();
  });

  it("moves from auth to the bid screen on sign-in", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    fireEvent.click(screen.getByText("Continue with Google"));
    expect(screen.getByText("Your bid")).toBeInTheDocument();
  });

  it("computes the deposit as 10% of the entered bid", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    fireEvent.click(screen.getByText("Continue with Google"));
    const bidInput = screen.getByLabelText(/your bid/i);
    fireEvent.change(bidInput, { target: { value: "10000" } });
    expect(screen.getByText("$1,000")).toBeInTheDocument();
  });

  it("moves to the lead screen after placing a deposit", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    fireEvent.click(screen.getByText("Continue with Google"));
    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "10000" } });
    fireEvent.click(screen.getByText("Place deposit"));
    expect(screen.getByText("You're first in line")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/AuctionFlow.test.tsx` (from `apps/web`)
Expected: FAIL — cannot find module `../src/components/AuctionFlow`.

- [ ] **Step 3: Write `apps/web/src/components/AuctionFlow.tsx`**

Implement the component as a single function component using `useState` for the current screen and form values. Read the prototype's `<sc-if value="{{ isAuth }}">` / `isBid` / `isLead` blocks (roughly lines 96-173 of [one-above-all.dc.html](../../../design/prototype/one-above-all.dc.html)) for the exact copy, layout, and field labels of each of these three screens — reproduce them as JSX with the same structure (step label header, close button, per-screen content), using the CSS custom properties from Task 3's tokens for all colors (inline `style` objects referencing `var(--gold)` etc., matching the prototype's inline-style approach).

Required behavior for this task's three screens:
- **closed**: price (via `formatMoney(mockCurrentPriceCents)`) + countdown (via `formatCountdown`, ticking every second off `mockBiddingWindowClosesAt`) + "Displace" button that sets screen to `"auth"`.
- **auth**: "Sign in to claim the seat" heading, "Continue with Google" / "Continue with Apple" buttons — either one advances to `"bid"` (no real OAuth yet).
- **bid**: "Your bid" heading, a bid amount `<input>` (labelled "Your bid, $" — use a `<label htmlFor>` / matching `id` pair so `getByLabelText` resolves it). The input's raw value is a **whole-dollar** figure, exactly what a user types (e.g. typing `10000` means "$10,000" — matching the prototype's UI convention, where `s.bid` is a plain dollar-scale number). Convert it to cents exactly once, immediately, via `Number(bidValue) * 100`, and do every downstream computation (deposit, remainder, comparisons) in cents from that point on — never re-derive dollars mid-calculation. Display the live-computed deposit via `formatMoney(calculateDepositDisplay(bidCents))`. A "Place deposit" button advances to `"lead"`.
- **lead**: "You're first in line" heading and the bid amount that was entered.
- A close ("×" or "Close") control on every overlay screen that returns to `"closed"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/AuctionFlow.test.tsx`
Expected: PASS — 5 tests passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat: add AuctionFlow island — closed/auth/bid/lead screens"
```

---

### Task 7: AuctionFlow — remaining screens (pay, upload, pending, missed, leaderboard)

**Files:**
- Modify: `apps/web/src/components/AuctionFlow.tsx`
- Modify: `apps/web/tests/AuctionFlow.test.tsx`

**Interfaces:**
- Consumes: `mockLeaderboard` (Task 4).
- Produces: the remaining screens wired into the same state machine from Task 6, plus a `"top"` (leaderboard) overlay reachable from the closed screen independent of the bidding flow.

- [ ] **Step 1: Write the failing tests (append to the existing file)**

```tsx
// append to apps/web/tests/AuctionFlow.test.tsx

describe("AuctionFlow — remaining screens", () => {
  it("moves from lead to the pay screen with the remaining balance", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    fireEvent.click(screen.getByText("Continue with Google"));
    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "10000" } });
    fireEvent.click(screen.getByText("Place deposit"));
    fireEvent.click(screen.getByText(/continue/i));
    expect(screen.getByText("Remaining balance due")).toBeInTheDocument();
    expect(screen.getByText("$9,000")).toBeInTheDocument(); // 10,000 - 1,000 deposit
  });

  it("moves from pay to the upload screen, gating submit on consent", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    fireEvent.click(screen.getByText("Continue with Google"));
    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "10000" } });
    fireEvent.click(screen.getByText("Place deposit"));
    fireEvent.click(screen.getByText(/continue/i));
    fireEvent.click(screen.getByText(/^Pay /));
    expect(screen.getByText("Send your face")).toBeInTheDocument();
    const submit = screen.getByText("Submit");
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByText(/I agree to have my photo published/));
    expect(submit).not.toBeDisabled();
  });

  it("moves from upload to the pending screen on submit", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Displace"));
    fireEvent.click(screen.getByText("Continue with Google"));
    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "10000" } });
    fireEvent.click(screen.getByText("Place deposit"));
    fireEvent.click(screen.getByText(/continue/i));
    fireEvent.click(screen.getByText(/^Pay /));
    fireEvent.click(screen.getByText(/I agree to have my photo published/));
    fireEvent.click(screen.getByText("Submit"));
    expect(screen.getByText("The scene is updating")).toBeInTheDocument();
  });

  it("shows the missed-payment screen with forfeiture details", () => {
    render(<AuctionFlow initialScreen="missed" />);
    expect(screen.getByText("The seat moved to the next in line")).toBeInTheDocument();
    expect(screen.getByText(/forfeited/)).toBeInTheDocument();
    expect(screen.getByText(/3-round pause/)).toBeInTheDocument();
  });

  it("opens the leaderboard from the closed screen and lists every mock row", () => {
    render(<AuctionFlow />);
    fireEvent.click(screen.getByText("Leaderboard"));
    expect(screen.getByText("Who held the seat the longest")).toBeInTheDocument();
    for (const row of [
      "Mark Vilensky",
      "Osei Adjei",
      "Daniel Crowe",
      "Felix Lang",
      "Y. Kimura",
      "Arthur Lemeshev",
      "Timur Aslanov",
      "Paul Renier",
    ]) {
      expect(screen.getByText(row)).toBeInTheDocument();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/AuctionFlow.test.tsx`
Expected: FAIL — `"top"`/`"pay"`/`"upload"`/`"pending"`/`"missed"` screens and the `initialScreen` prop don't exist yet.

- [ ] **Step 3: Extend `apps/web/src/components/AuctionFlow.tsx`**

Add an optional `initialScreen?: Screen` prop (default `"closed"`, used only by tests to jump straight to a screen — the real app always starts at `"closed"`).

Read the prototype's `isPay` / `isUpload` / `isPending` / `isMissed` / `isTop` blocks (roughly lines 175-264 of [one-above-all.dc.html](../../../design/prototype/one-above-all.dc.html)) for exact copy and layout, and implement:
- **pay**: "Remaining balance due" heading, remaining amount computed as `bidCents - calculateDepositDisplay(bidCents)` (using the same cents value carried over from the bid screen — don't re-parse the dollar input), formatted via `formatMoney`, a payment-window countdown, a "Pay {amount}" button advancing to `"upload"`.
- **upload**: "Send your face" heading, a file-picker affordance (a styled `<button>`/label — no real upload wiring needed yet), a consent checkbox with the exact copy "I agree to have my photo published on the homepage and in the champions archive.", and a "Submit" button disabled until consent is checked, advancing to `"pending"` when clicked.
- **pending**: "The scene is updating" heading and body copy, a "Back to the scene" button returning to `"closed"`.
- **missed**: "The seat moved to the next in line" heading, a two-row summary (deposit forfeited, "3-round pause" participation note), a "Back to the scene" button.
- **top** (leaderboard): reachable via a "Leaderboard" button visible on the `"closed"` screen (alongside the existing price/Displace chrome), rendering `mockLeaderboard` as a ranked list (rank, name, rounds, spent, days) with a close control back to `"closed"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/AuctionFlow.test.tsx`
Expected: PASS — all 10 tests (5 from Task 6 + 5 new) passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat: add remaining AuctionFlow screens and leaderboard overlay"
```

---

### Task 8: Wire the island into the page and verify end-to-end in a browser

**Files:**
- Modify: `apps/web/src/pages/index.astro`

**Interfaces:**
- Consumes: `Scene` (Task 5), `AuctionFlow` (Tasks 6-7), `mockScene` (Task 4).

- [ ] **Step 1: Update `apps/web/src/pages/index.astro`**

```astro
---
import BaseLayout from "../layouts/BaseLayout.astro";
import Scene from "../components/Scene.astro";
import AuctionFlow from "../components/AuctionFlow";
import { mockScene } from "../lib/mockData";
---
<BaseLayout title="oneabobeall">
  <Scene scene={mockScene} />
  <AuctionFlow client:idle />
</BaseLayout>
```

`client:idle` defers hydrating the interactive island until the browser is idle, so the initial paint (the scene image + chrome) isn't blocked by React — matching the "opens instantly" principle.

- [ ] **Step 2: Run the full test suite and typecheck**

```bash
npm run typecheck --workspace=apps/web
npm test --workspace=apps/web
```

Expected: typecheck clean, all tests (format + AuctionFlow) passing.

- [ ] **Step 3: Build and manually verify in a browser**

```bash
npm run build --workspace=apps/web
npm run preview --workspace=apps/web
```

Open the preview URL. Walk the full flow manually: hover each of the 9 people and confirm stat cards; click "Displace" → sign in → enter a bid → confirm the deposit updates live → place deposit → continue → pay → upload (check consent, confirm Submit enables) → submit → see the pending screen → back to scene; separately open the leaderboard and confirm all 8 rows render. Open [design/prototype/one-above-all.dc.html](../../../design/prototype/one-above-all.dc.html) side-by-side in another tab and compare each screen — note and fix any visible divergence in spacing, color, or copy before calling this done. Also toggle the OS/browser dark-light preference or the prototype's theme button equivalent if you added one (not required by this task if the prototype's specific toggle button wasn't ported — dark mode via `[data-theme]` defaulting to unset/dark is sufficient).

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "feat: wire AuctionFlow island into the public page"
```

---

## Self-Review Notes

- **Spec coverage:** scene composition + hover cards (Task 5), retinue-of-8/last-champions-first mock ordering (Task 4), the full auth→bid→lead→pay→upload→pending/missed flow (Tasks 6-7) matching [ui-reference.md](../specs/2026-08-12-ui-reference.md)'s screen inventory, leaderboard (Task 7), static/no-live-endpoint delivery model (Tasks 5-8 — no fetch/polling anywhere), design tokens matching the prototype exactly (Task 3), monorepo restructuring needed before a second app could exist (Task 1) — all covered.
- **Deferred to later plans, intentionally:** real OAuth, real payment provider integration, real photo upload handling, wiring to the actual auction engine (`apps/engine`) instead of mock data — that requires an HTTP API layer that doesn't exist yet and is a separate plan, real content-hashed static asset publishing/CDN wiring per [public-page-delivery-design.md](../specs/2026-08-06-public-page-delivery-design.md) (this plan produces the app; deployment/publishing pipeline is separate).
