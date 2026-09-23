# Personal Account, OAuth & Live Auction Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real Google/Apple sign-in, a personal-account dashboard, and a live auction page inside
it (real-time price, Stripe-backed deposit "Join", free bid submission) — one plan, one branch,
per the user's explicit instruction to keep this simple rather than split into three.

**Architecture:** New `users`/`sessions` tables and OAuth routes on `apps/api` (session delivered
via an httpOnly cookie); `apps/web` gains two new **statically built** pages (`account.astro`,
`account/auction.astro`) whose content is entirely client-side — a React island checks the
session via `GET /auth/me` and, on the auction page, polls live round state and drives the
Stripe Elements deposit form and bid submission. `apps/web`'s existing `output: "static"` mode
is never changed; no SSR adapter is introduced.

**Tech Stack:** `openid-client@^5` (OIDC client, Google + Apple), `jose` (Apple's JWT client
secret), `@fastify/cookie`, `@fastify/cors`, `@stripe/stripe-js` + `@stripe/react-stripe-js`
(new `apps/web` dependencies), Vitest + real local Postgres (unchanged pattern).

## Global Constraints

- Money is always integer cents (unchanged — no money-math in this plan; it reuses the engine's
  existing `calculateDeposit`).
- `users.id` is the engine's `bidderId` directly — no new mapping table, no engine schema change
  beyond this plan's own `users`/`sessions` tables.
- Session tokens are opaque, server-validated, stored server-side — never a client-decodable JWT.
- Two OAuth accounts (one Google, one Apple) for the same real person are two separate `users`
  rows. No account linking/merging.
- `apps/web/src/pages/index.astro` (the public scene) is never modified. It stays fully static.
- `apps/web/astro.config.mjs` stays `output: "static"`. No SSR adapter is added. Every new page
  is a static shell; all dynamic behavior is client-side `fetch` calls against `apps/api`.
- `apps/api` and `apps/web` are different origins in local dev (`127.0.0.1:3001` vs
  `127.0.0.1:4322`) and the same origin in production (Traefik path-routes
  `oneabobeall.org/api/*`) — cross-origin cookie delivery must work in dev, so every
  browser-facing fetch that needs the session cookie uses `credentials: "include"`, and
  `apps/api` is configured with CORS restricted to one known origin (never a wildcard, since
  credentials are involved).
- Client-side polling of live state pauses when the tab is hidden
  (`document.visibilityState`) and immediately re-fetches once on becoming visible again.

---

### Task 1: Schema — `users` and `sessions` tables

**Files:**
- Modify: `apps/engine/src/db/schema.ts`
- Test: `apps/engine/tests/db/schema.test.ts`

**Interfaces:**
- Produces: `users` table (Drizzle table object) — `{ id: uuid pk, provider: text, providerId: text, email: text, name: text, createdAt: timestamp }`, unique on `(provider, providerId)`. `sessions` table — `{ token: text pk, userId: uuid fk->users.id, expiresAt: timestamp, createdAt: timestamp }`.

- [ ] **Step 1: Update the schema file**

Add to `apps/engine/src/db/schema.ts` (append after the existing `bans` table; keep every
existing export exactly as-is):

```ts
// A signed-in bidder. provider+providerId is the OAuth identity; id is what
// the rest of the engine already calls bidderId (its columns are plain
// `text`, so no other table changes — a user's id is used directly).
// Two OAuth accounts for the same real person (one Google, one Apple)
// deliberately produce two separate rows here — account linking is out of
// scope.
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: text("provider").notNull(), // "google" | "apple"
  providerId: text("provider_id").notNull(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  providerIdentityIdx: uniqueIndex("users_provider_provider_id_idx").on(table.provider, table.providerId),
}));

// An opaque, server-validated session token — never a client-decodable JWT.
// The browser only ever sees `token`, delivered as an httpOnly cookie.
export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Push the schema**

Run: `npm run db:push --workspace=apps/engine -- --force`

- [ ] **Step 3: Add a smoke test**

Append to `apps/engine/tests/db/schema.test.ts` (inside the existing `describe("schema", ...)`
block, after the `roundParticipants` test added by the prior plan):

```ts
  it("can insert a user and a session, and rejects a duplicate (provider, providerId)", async () => {
    const [user] = await db
      .insert(users)
      .values({ provider: "google", providerId: "g-1", email: "a@example.com", name: "A" })
      .returning();
    expect(user.id).toBeTruthy();

    await expect(
      db.insert(users).values({ provider: "google", providerId: "g-1", email: "dup@example.com", name: "Dup" }),
    ).rejects.toThrow();

    const [session] = await db
      .insert(sessions)
      .values({ token: "tok_1", userId: user.id, expiresAt: new Date(Date.now() + 3600_000) })
      .returning();
    expect(session.userId).toBe(user.id);

    await db.delete(sessions).where(eq(sessions.token, "tok_1"));
    await db.delete(users).where(eq(users.id, user.id));
  });
```

Update the file's import line to include the new tables:

```ts
import { reigns, rounds, roundParticipants, users, sessions } from "../../src/db/schema";
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=apps/engine -- schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/engine/src/db/schema.ts apps/engine/tests/db/schema.test.ts
git commit -m "feat(engine): add users and sessions tables"
```

---

### Task 2: `apps/api` infra — cookies, CORS, session helpers

**Files:**
- Create: `apps/api/src/auth/session.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/package.json` (add `@fastify/cookie`, `@fastify/cors`)
- Modify: `apps/api/.env.example`
- Test: `apps/api/tests/auth/session.test.ts`

**Interfaces:**
- Produces:
  - `createSession(userId: string): Promise<{ token: string; expiresAt: Date }>` — inserts a
    `sessions` row with a cryptographically random token (32 bytes, hex-encoded) and a 30-day
    expiry.
  - `getUserBySessionToken(token: string): Promise<{ id: string; email: string; name: string } | null>`
    — joins `sessions` to `users`, returns `null` for a missing or expired token (does not throw).
  - `deleteSession(token: string): Promise<void>`.
  - `SESSION_COOKIE_NAME = "oneabobeall_session"` (exported constant, used by every route that
    sets or reads the cookie).
- Consumes: `users`, `sessions` (Task 1).

- [ ] **Step 1: Add dependencies**

Add to `apps/api/package.json`'s `"dependencies"`:

```json
    "@fastify/cookie": "^9.4.0",
    "@fastify/cors": "^9.0.1",
```

Run: `npm install --workspace=apps/api`

- [ ] **Step 2: Add env vars**

Replace `apps/api/.env.example` with:

```
DATABASE_URL=postgres://auction:auction@localhost:5433/auction_engine_test
PORT=3001
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
CORS_ORIGIN=http://127.0.0.1:4322
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
APPLE_TEAM_ID=...
APPLE_KEY_ID=...
APPLE_SERVICES_ID=...
APPLE_PRIVATE_KEY_PATH=./apple-private-key.p8
PUBLIC_APP_URL=http://127.0.0.1:4322
API_PUBLIC_URL=http://127.0.0.1:3001
```

(`PUBLIC_APP_URL` is where OAuth callbacks redirect the browser back to after sign-in;
`API_PUBLIC_URL` is this service's own externally-reachable base URL, used to build the OAuth
`redirect_uri`s registered with Google/Apple.)

- [ ] **Step 3: Write the failing test**

Create `apps/api/tests/auth/session.test.ts`:

```ts
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "engine/db/client";
import { users, sessions } from "engine/db/schema";
import { createSession, getUserBySessionToken, deleteSession } from "../../src/auth/session";

afterEach(async () => {
  await db.delete(sessions);
  await db.delete(users);
});

afterAll(async () => {
  await pool.end();
});

async function seedUser() {
  const [user] = await db
    .insert(users)
    .values({ provider: "google", providerId: "g-1", email: "a@example.com", name: "A" })
    .returning();
  return user;
}

describe("createSession / getUserBySessionToken / deleteSession", () => {
  it("creates a session and resolves it back to the user", async () => {
    const user = await seedUser();
    const { token, expiresAt } = await createSession(user.id);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const resolved = await getUserBySessionToken(token);
    expect(resolved).toMatchObject({ id: user.id, email: "a@example.com", name: "A" });
  });

  it("returns null for an unknown token", async () => {
    expect(await getUserBySessionToken("does-not-exist")).toBeNull();
  });

  it("returns null for an expired session", async () => {
    const user = await seedUser();
    await db.insert(sessions).values({ token: "expired-tok", userId: user.id, expiresAt: new Date(Date.now() - 1000) });
    expect(await getUserBySessionToken("expired-tok")).toBeNull();
  });

  it("deleteSession removes the row so it no longer resolves", async () => {
    const user = await seedUser();
    const { token } = await createSession(user.id);
    await deleteSession(token);
    expect(await getUserBySessionToken(token)).toBeNull();
  });

  it("generates a different token on every call", async () => {
    const user = await seedUser();
    const a = await createSession(user.id);
    const b = await createSession(user.id);
    expect(a.token).not.toBe(b.token);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npm test --workspace=apps/api -- session.test.ts`
Expected: FAIL (`../../src/auth/session` does not exist)

- [ ] **Step 5: Implement**

Create `apps/api/src/auth/session.ts`:

```ts
import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "engine/db/client";
import { sessions, users } from "engine/db/schema";

export const SESSION_COOKIE_NAME = "oneabobeall_session";

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  await db.insert(sessions).values({ token, userId, expiresAt });
  return { token, expiresAt };
}

export async function getUserBySessionToken(
  token: string,
): Promise<{ id: string; email: string; name: string } | null> {
  const [row] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function deleteSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token, token));
}
```

- [ ] **Step 6: Wire cookie + CORS plugins into `server.ts`**

Modify `apps/api/src/server.ts`: add the imports and two `app.register(...)` calls, right after
`const app = Fastify({ logger: true });` and before the custom content-type parser:

```ts
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
```

```ts
  const corsOrigin = process.env.CORS_ORIGIN;
  if (!corsOrigin) {
    throw new Error("CORS_ORIGIN is required.");
  }
  app.register(fastifyCors, { origin: corsOrigin, credentials: true });
  app.register(fastifyCookie);
```

(Full resulting top of `buildServer()`:)

```ts
export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  const corsOrigin = process.env.CORS_ORIGIN;
  if (!corsOrigin) {
    throw new Error("CORS_ORIGIN is required.");
  }
  app.register(fastifyCors, { origin: corsOrigin, credentials: true });
  app.register(fastifyCookie);

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    // ... unchanged, existing code stays exactly as it is ...
```

Leave everything else in `server.ts` untouched — do not reorder the existing route
registrations or the content-type parser.

- [ ] **Step 7: Run tests**

Run: `npm test --workspace=apps/api -- session.test.ts`
Expected: PASS (5 tests)

Then run the full `apps/api` suite to confirm the new CORS/cookie registration didn't break
anything: `npm test --workspace=apps/api`. Every existing test builds the server via
`buildServer()`, so a missing `CORS_ORIGIN` env var would now break them all — confirm
`apps/api/.env` in this worktree already has `CORS_ORIGIN` set (it does not yet; add
`CORS_ORIGIN=http://127.0.0.1:4322` to it now, the same way `STRIPE_SECRET_KEY` was added in an
earlier plan — this file is gitignored and worktree-local, not part of the commit).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/auth/session.ts apps/api/src/server.ts apps/api/package.json apps/api/package-lock.json apps/api/.env.example apps/api/tests/auth/session.test.ts
git commit -m "feat(api): add session helpers, cookie/CORS plugins"
```

---

### Task 3: Google OAuth (`GET /auth/google`, `GET /auth/google/callback`)

**Files:**
- Create: `apps/api/src/auth/oauthState.ts`
- Create: `apps/api/src/routes/authGoogle.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/package.json` (add `openid-client`)
- Test: `apps/api/tests/authGoogle.test.ts`

**Interfaces:**
- Consumes: `createSession`, `SESSION_COOKIE_NAME` (Task 2).
- Produces:
  - `apps/api/src/auth/oauthState.ts`: `OAUTH_STATE_COOKIE_NAME = "oneabobeall_oauth_state"`,
    `generateState(): string`, `generateCodeVerifier(): string`,
    `generateCodeChallenge(verifier: string): string` — thin wrappers around `openid-client`'s
    `generators` module (re-exported here so route files import one local module instead of
    reaching into the library directly, and so Task 4's Apple routes reuse the same state
    helper without duplicating it).
  - `registerGoogleAuthRoutes(app: FastifyInstance): void` — registers `GET /auth/google` and
    `GET /auth/google/callback`.

**Before this task, read `node_modules/openid-client/types/index.d.ts` in this worktree** (once
the dependency is installed in Step 1) to confirm the exact exported names
(`Issuer`, `generators`) and the `Client` instance method signatures
(`authorizationUrl`, `callbackParams`, `callback`) match what this task's code uses below —
`openid-client` is pinned to `^5`, but confirm against the installed version's own types rather
than trusting this description, the same discipline this project has applied to every other
external integration.

- [ ] **Step 1: Add the dependency**

Add to `apps/api/package.json`'s `"dependencies"`:

```json
    "openid-client": "^5.7.1",
```

Run: `npm install --workspace=apps/api`

- [ ] **Step 2: Write the failing test**

Create `apps/api/tests/authGoogle.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

const authorizationUrl = vi.fn(() => "https://accounts.google.com/o/oauth2/v2/auth?mock=1");
const callback = vi.fn(async () => ({
  claims: () => ({ sub: "google-sub-1", email: "a@example.com", name: "A Person" }),
}));

vi.mock("openid-client", () => ({
  Issuer: {
    discover: vi.fn(async () => ({
      Client: class {
        authorizationUrl = authorizationUrl;
        callbackParams = vi.fn((req: unknown) => ({ code: "mock-code", state: "mock-state" }));
        callback = callback;
      },
    })),
  },
  generators: {
    state: () => "mock-state",
    codeVerifier: () => "mock-verifier",
    codeChallenge: () => "mock-challenge",
  },
}));

vi.mock("engine/db/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("engine/db/schema")>();
  return actual;
});

describe("GET /auth/google", () => {
  it("redirects to Google's authorization URL and sets a state cookie", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/auth/google" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://accounts.google.com/o/oauth2/v2/auth?mock=1");
    expect(response.headers["set-cookie"]).toBeDefined();
    const cookies = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [response.headers["set-cookie"]];
    expect(cookies.some((c) => c?.includes("oneabobeall_oauth_state="))).toBe(true);
  });
});

describe("GET /auth/google/callback", () => {
  it("rejects a missing state cookie with 400", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/auth/google/callback?code=x&state=y" });
    expect(response.statusCode).toBe(400);
  });
});
```

This task's callback happy path (creating a user, a session, and redirecting) is covered in
Step 4 below once the real DB-backed upsert logic exists — keep the two tests above as the
Step-2 failing baseline, then add the DB-backed ones in Step 4's own test-first pass.

- [ ] **Step 3: Run to verify it fails**

Run: `npm test --workspace=apps/api -- authGoogle.test.ts`
Expected: FAIL (`../src/routes/authGoogle` doesn't exist, route not registered)

- [ ] **Step 4: Add the DB-backed callback tests**

Append to `apps/api/tests/authGoogle.test.ts`, inside the `describe("GET /auth/google/callback", ...)` block:

```ts
  it("creates a new user, a session, sets the session cookie, and redirects to the app", async () => {
    const app = buildServer();
    const stateResponse = await app.inject({ method: "GET", url: "/auth/google" });
    const stateCookie = (Array.isArray(stateResponse.headers["set-cookie"]) ? stateResponse.headers["set-cookie"] : [stateResponse.headers["set-cookie"]])
      .find((c) => c?.includes("oneabobeall_oauth_state="))!;

    const response = await app.inject({
      method: "GET",
      url: "/auth/google/callback?code=mock-code&state=mock-state",
      headers: { cookie: stateCookie.split(";")[0] },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(process.env.PUBLIC_APP_URL + "/account");
    const cookies = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [response.headers["set-cookie"]];
    expect(cookies.some((c) => c?.includes("oneabobeall_session="))).toBe(true);

    const { db, pool } = await import("engine/db/client");
    const { users } = await import("engine/db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await db.select().from(users).where(eq(users.provider, "google"));
    expect(user.email).toBe("a@example.com");
    expect(user.providerId).toBe("google-sub-1");
    await db.delete(users).where(eq(users.id, user.id));
    await pool.end();
  });
```

- [ ] **Step 5: Run to verify these fail too**

Run: `npm test --workspace=apps/api -- authGoogle.test.ts`
Expected: FAIL

- [ ] **Step 6: Implement `oauthState.ts`**

Create `apps/api/src/auth/oauthState.ts`:

```ts
import { generators } from "openid-client";

export const OAUTH_STATE_COOKIE_NAME = "oneabobeall_oauth_state";

export function generateState(): string {
  return generators.state();
}

export function generateCodeVerifier(): string {
  return generators.codeVerifier();
}

export function generateCodeChallenge(verifier: string): string {
  return generators.codeChallenge(verifier);
}
```

- [ ] **Step 7: Implement the route**

Create `apps/api/src/routes/authGoogle.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { Issuer } from "openid-client";
import { createSession, SESSION_COOKIE_NAME } from "../auth/session";
import { OAUTH_STATE_COOKIE_NAME, generateState, generateCodeVerifier, generateCodeChallenge } from "../auth/oauthState";
import { db } from "engine/db/client";
import { users } from "engine/db/schema";
import { and, eq } from "drizzle-orm";

// Issuer.discover() fetches Google's .well-known/openid-configuration over
// the network — this config doesn't change at runtime, so caching it at
// module scope avoids an extra network round-trip on every single sign-in
// attempt (both server load and the signing-in user's own latency).
// Constructing a Client from the cached issuer is a cheap, synchronous,
// no-network operation, so that part stays uncached/per-call.
let googleIssuer: Awaited<ReturnType<typeof Issuer.discover>> | null = null;

async function getGoogleClient() {
  if (!googleIssuer) {
    googleIssuer = await Issuer.discover("https://accounts.google.com");
  }
  return new googleIssuer.Client({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    redirect_uris: [`${process.env.API_PUBLIC_URL}/auth/google/callback`],
    response_types: ["code"],
  });
}

export function registerGoogleAuthRoutes(app: FastifyInstance): void {
  app.get("/auth/google", async (request, reply) => {
    const client = await getGoogleClient();
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // Packed into one cookie value (state + verifier) since both are needed
    // back at the callback and no user session exists yet to store them
    // server-side against. Short-lived and httpOnly — this cookie carries no
    // user data, just the handshake's own nonces.
    reply.setCookie(OAUTH_STATE_COOKIE_NAME, `${state}.${codeVerifier}`, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });

    const url = client.authorizationUrl({
      scope: "openid email profile",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    reply.redirect(url);
  });

  app.get("/auth/google/callback", async (request, reply) => {
    const raw = request.cookies[OAUTH_STATE_COOKIE_NAME];
    if (!raw) {
      reply.code(400);
      return { error: "missing oauth state cookie" };
    }
    const [expectedState, codeVerifier] = raw.split(".");

    const client = await getGoogleClient();
    const params = client.callbackParams(request.raw);

    if (params.state !== expectedState) {
      reply.code(400);
      return { error: "state mismatch" };
    }

    let claims: { sub: string; email?: string; name?: string };
    try {
      const tokenSet = await client.callback(
        `${process.env.API_PUBLIC_URL}/auth/google/callback`,
        params,
        { state: expectedState, code_verifier: codeVerifier },
      );
      claims = tokenSet.claims();
    } catch (err) {
      request.log.error({ err }, "Google OAuth callback failed");
      reply.code(400);
      return { error: "sign-in failed" };
    }

    const [existing] = await db
      .select()
      .from(users)
      .where(and(eq(users.provider, "google"), eq(users.providerId, claims.sub)))
      .limit(1);

    const user =
      existing ??
      (
        await db
          .insert(users)
          .values({
            provider: "google",
            providerId: claims.sub,
            email: claims.email ?? "",
            name: claims.name ?? "",
          })
          .returning()
      )[0];

    const { token, expiresAt } = await createSession(user.id);
    reply.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: "/" });
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      expires: expiresAt,
      path: "/",
    });

    reply.redirect(`${process.env.PUBLIC_APP_URL}/account`);
  });
}
```

- [ ] **Step 8: Wire the route into `server.ts`**

Add the import and registration call to `apps/api/src/server.ts`:

```ts
import { registerGoogleAuthRoutes } from "./routes/authGoogle";
```

```ts
  registerGoogleAuthRoutes(app);
```

(alongside the other `register*Route(app)`/`register*AuthRoutes(app)` calls)

- [ ] **Step 9: Run tests**

Run: `npm test --workspace=apps/api -- authGoogle.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/auth/oauthState.ts apps/api/src/routes/authGoogle.ts apps/api/src/server.ts apps/api/package.json apps/api/package-lock.json apps/api/tests/authGoogle.test.ts
git commit -m "feat(api): add Google OAuth sign-in"
```

---

### Task 4: Apple OAuth (`GET /auth/apple`, `POST /auth/apple/callback`)

**Files:**
- Create: `apps/api/src/auth/appleClientSecret.ts`
- Create: `apps/api/src/routes/authApple.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/package.json` (add `jose`)
- Test: `apps/api/tests/authApple.test.ts`

**Interfaces:**
- Consumes: `createSession`, `SESSION_COOKIE_NAME` (Task 2); `OAUTH_STATE_COOKIE_NAME`,
  `generateState`, `generateCodeVerifier`, `generateCodeChallenge` (Task 3).
- Produces:
  - `generateAppleClientSecret(): Promise<string>` — a short-lived (5-minute) ES256-signed JWT
    per Apple's Sign in with Apple client-secret requirement (`iss`=`APPLE_TEAM_ID`,
    `sub`=`APPLE_SERVICES_ID`, `aud`="https://appleid.apple.com", signed with the `.p8` key
    identified by `APPLE_KEY_ID`). Regenerated on every call rather than cached — a JWT sign
    operation is cheap and this avoids a stale-secret expiry edge case entirely.
  - `registerAppleAuthRoutes(app: FastifyInstance): void` — registers `GET /auth/apple` and
    `POST /auth/apple/callback`.

**Apple-specific behavior this task must get right (see the design spec for the full
rationale):** the callback is a POST (Apple's protocol, not Google's GET), the private key
lives in a file at `APPLE_PRIVATE_KEY_PATH` (read once at process start, not per-request), and
`email`/`name` are only present in Apple's response on the user's very first authorization —
every later sign-in for the same `(provider, providerId)` omits them, so the upsert must persist
them on creation and never expect them again on a returning user.

**Read `node_modules/jose/dist/types/index.d.ts` and `node_modules/openid-client/types/index.d.ts`
in this worktree (once both are installed in Step 1) to confirm the exact API this task's code
below uses** — `jose`'s `SignJWT`/`importPKCS8` and `openid-client`'s `Issuer`/`generators`, the
same verify-against-the-real-package discipline as Task 3.

- [ ] **Step 1: Add the dependency and a placeholder key file**

Add to `apps/api/package.json`'s `"dependencies"`:

```json
    "jose": "^5.9.6",
```

Run: `npm install --workspace=apps/api`

Create a placeholder `apps/api/apple-private-key.p8.example` (committed, documents the expected
format; the real `.p8` the user downloads from Apple Developer goes at
`apps/api/apple-private-key.p8`, gitignored):

```
-----BEGIN PRIVATE KEY-----
(paste the contents of the .p8 file Apple gives you when you create a
"Sign in with Apple" key in the Apple Developer portal here)
-----END PRIVATE KEY-----
```

Add `apple-private-key.p8` to `apps/api/.gitignore` (create the file if it doesn't exist, or
append to it if it does — check first).

- [ ] **Step 2: Write the failing test**

Create `apps/api/tests/authApple.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

const callback = vi.fn(async () => ({
  claims: () => ({ sub: "apple-sub-1" }),
}));

vi.mock("openid-client", () => ({
  Issuer: {
    discover: vi.fn(async () => ({
      Client: class {
        authorizationUrl = vi.fn(() => "https://appleid.apple.com/auth/authorize?mock=1");
        callbackParams = vi.fn(() => ({ code: "mock-code", state: "mock-state" }));
        callback = callback;
      },
    })),
  },
  generators: {
    state: () => "mock-state",
    codeVerifier: () => "mock-verifier",
    codeChallenge: () => "mock-challenge",
  },
}));

vi.mock("../src/auth/appleClientSecret", () => ({
  generateAppleClientSecret: vi.fn(async () => "mock.jwt.secret"),
}));

describe("GET /auth/apple", () => {
  it("redirects to Apple's authorization URL and sets a state cookie", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/auth/apple" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://appleid.apple.com/auth/authorize?mock=1");
    const cookies = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [response.headers["set-cookie"]];
    expect(cookies.some((c) => c?.includes("oneabobeall_oauth_state="))).toBe(true);
  });
});

describe("POST /auth/apple/callback", () => {
  it("rejects a missing state cookie with 400", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/auth/apple/callback", payload: { code: "x", state: "y" } });
    expect(response.statusCode).toBe(400);
  });

  it("creates a new user from user data present only on first authorization, sets a session, and redirects", async () => {
    const app = buildServer();
    const stateResponse = await app.inject({ method: "GET", url: "/auth/apple" });
    const stateCookie = (Array.isArray(stateResponse.headers["set-cookie"]) ? stateResponse.headers["set-cookie"] : [stateResponse.headers["set-cookie"]])
      .find((c) => c?.includes("oneabobeall_oauth_state="))!;

    const response = await app.inject({
      method: "POST",
      url: "/auth/apple/callback",
      headers: { cookie: stateCookie.split(";")[0] },
      payload: {
        code: "mock-code",
        state: "mock-state",
        // Apple sends this JSON-encoded-string "user" field only on the
        // FIRST authorization for a given app; it carries the name, since
        // Apple's id_token itself never carries a name claim at all.
        user: JSON.stringify({ name: { firstName: "A", lastName: "Person" }, email: "a@privaterelay.appleid.com" }),
      },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(process.env.PUBLIC_APP_URL + "/account");

    const { db, pool } = await import("engine/db/client");
    const { users } = await import("engine/db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await db.select().from(users).where(eq(users.provider, "apple"));
    expect(user.providerId).toBe("apple-sub-1");
    expect(user.name).toBe("A Person");
    expect(user.email).toBe("a@privaterelay.appleid.com");
    await db.delete(users).where(eq(users.id, user.id));
    await pool.end();
  });

  it("a returning user's callback (no 'user' field) reuses the existing row without erasing name/email", async () => {
    const { db, pool } = await import("engine/db/client");
    const { users } = await import("engine/db/schema");
    const { eq } = await import("drizzle-orm");
    const [seeded] = await db.insert(users).values({ provider: "apple", providerId: "apple-sub-1", email: "a@privaterelay.appleid.com", name: "A Person" }).returning();

    const app = buildServer();
    const stateResponse = await app.inject({ method: "GET", url: "/auth/apple" });
    const stateCookie = (Array.isArray(stateResponse.headers["set-cookie"]) ? stateResponse.headers["set-cookie"] : [stateResponse.headers["set-cookie"]])
      .find((c) => c?.includes("oneabobeall_oauth_state="))!;

    const response = await app.inject({
      method: "POST",
      url: "/auth/apple/callback",
      headers: { cookie: stateCookie.split(";")[0] },
      payload: { code: "mock-code", state: "mock-state" },
    });

    expect(response.statusCode).toBe(302);
    const rows = await db.select().from(users).where(eq(users.provider, "apple"));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(seeded.id);
    expect(rows[0].name).toBe("A Person");

    await db.delete(users).where(eq(users.id, seeded.id));
    await pool.end();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test --workspace=apps/api -- authApple.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement `appleClientSecret.ts`**

Create `apps/api/src/auth/appleClientSecret.ts`:

```ts
import { readFileSync } from "node:fs";
import { SignJWT, importPKCS8 } from "jose";

// Read lazily (on first real call), not at module top level. This file is
// imported transitively by every apps/api test that builds the server
// (server.ts -> authApple.ts -> here) — an eager top-level readFileSync
// would make EVERY test in the workspace require a real private-key file on
// disk just to load the module, even tests that never touch Apple sign-in
// and already mock this module's export away. A lazy, cached read means
// only a genuine call to generateAppleClientSecret() (which only this
// file's own test exercises for real — every other test mocks the export
// entirely, so the mock intercepts the import before this code ever runs)
// needs the file to exist.
let cachedPrivateKeyPem: string | null = null;
function getPrivateKeyPem(): string {
  if (!cachedPrivateKeyPem) {
    cachedPrivateKeyPem = readFileSync(process.env.APPLE_PRIVATE_KEY_PATH!, "utf8");
  }
  return cachedPrivateKeyPem;
}

export async function generateAppleClientSecret(): Promise<string> {
  const key = await importPKCS8(getPrivateKeyPem(), "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: process.env.APPLE_KEY_ID! })
    .setIssuer(process.env.APPLE_TEAM_ID!)
    .setSubject(process.env.APPLE_SERVICES_ID!)
    .setAudience("https://appleid.apple.com")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}
```

- [ ] **Step 5: Implement the route**

Create `apps/api/src/routes/authApple.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { Issuer } from "openid-client";
import { createSession, SESSION_COOKIE_NAME } from "../auth/session";
import { OAUTH_STATE_COOKIE_NAME, generateState, generateCodeVerifier, generateCodeChallenge } from "../auth/oauthState";
import { generateAppleClientSecret } from "../auth/appleClientSecret";
import { db } from "engine/db/client";
import { users } from "engine/db/schema";
import { and, eq } from "drizzle-orm";

// Same reasoning as Google's cached issuer above — Apple's own
// .well-known/openid-configuration doesn't change at runtime either.
let appleIssuer: Awaited<ReturnType<typeof Issuer.discover>> | null = null;

async function getAppleClient(clientSecret: string) {
  if (!appleIssuer) {
    appleIssuer = await Issuer.discover("https://appleid.apple.com");
  }
  return new appleIssuer.Client({
    client_id: process.env.APPLE_SERVICES_ID!,
    client_secret: clientSecret,
    redirect_uris: [`${process.env.API_PUBLIC_URL}/auth/apple/callback`],
    response_types: ["code"],
  });
}

export function registerAppleAuthRoutes(app: FastifyInstance): void {
  app.get("/auth/apple", async (request, reply) => {
    const clientSecret = await generateAppleClientSecret();
    const client = await getAppleClient(clientSecret);
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    reply.setCookie(OAUTH_STATE_COOKIE_NAME, `${state}.${codeVerifier}`, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });

    const url = client.authorizationUrl({
      scope: "name email",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      response_mode: "form_post",
    });

    reply.redirect(url);
  });

  app.post<{ Body: { code?: string; state?: string; user?: string } }>("/auth/apple/callback", async (request, reply) => {
    const raw = request.cookies[OAUTH_STATE_COOKIE_NAME];
    if (!raw) {
      reply.code(400);
      return { error: "missing oauth state cookie" };
    }
    const [expectedState, codeVerifier] = raw.split(".");

    if (request.body?.state !== expectedState) {
      reply.code(400);
      return { error: "state mismatch" };
    }

    const clientSecret = await generateAppleClientSecret();
    const client = await getAppleClient(clientSecret);

    let claims: { sub: string };
    try {
      const tokenSet = await client.callback(
        `${process.env.API_PUBLIC_URL}/auth/apple/callback`,
        { code: request.body.code, state: request.body.state },
        { state: expectedState, code_verifier: codeVerifier },
      );
      claims = tokenSet.claims();
    } catch (err) {
      request.log.error({ err }, "Apple OAuth callback failed");
      reply.code(400);
      return { error: "sign-in failed" };
    }

    const [existing] = await db
      .select()
      .from(users)
      .where(and(eq(users.provider, "apple"), eq(users.providerId, claims.sub)))
      .limit(1);

    let user = existing;
    if (!user) {
      // Apple includes this JSON-encoded "user" field, with name and email,
      // ONLY on the very first authorization for this app — every later
      // sign-in omits it entirely. It must be captured now; it will never be
      // sent again for this (provider, providerId).
      let email = "";
      let name = "";
      if (request.body.user) {
        try {
          const parsed = JSON.parse(request.body.user) as { email?: string; name?: { firstName?: string; lastName?: string } };
          email = parsed.email ?? "";
          name = [parsed.name?.firstName, parsed.name?.lastName].filter(Boolean).join(" ");
        } catch {
          // Malformed "user" field — proceed with an empty name/email rather
          // than failing the whole sign-in over a non-essential field.
        }
      }
      [user] = await db
        .insert(users)
        .values({ provider: "apple", providerId: claims.sub, email, name })
        .returning();
    }

    const { token, expiresAt } = await createSession(user.id);
    reply.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: "/" });
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      expires: expiresAt,
      path: "/",
    });

    reply.redirect(`${process.env.PUBLIC_APP_URL}/account`);
  });
}
```

- [ ] **Step 6: Wire the route into `server.ts`**

Add the import and registration call to `apps/api/src/server.ts`:

```ts
import { registerAppleAuthRoutes } from "./routes/authApple";
```

```ts
  registerAppleAuthRoutes(app);
```

- [ ] **Step 7: Run tests**

Run: `npm test --workspace=apps/api -- authApple.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/auth/appleClientSecret.ts apps/api/src/routes/authApple.ts apps/api/src/server.ts apps/api/package.json apps/api/package-lock.json apps/api/apple-private-key.p8.example apps/api/.gitignore apps/api/tests/authApple.test.ts
git commit -m "feat(api): add Apple OAuth sign-in"
```

---

### Task 5: `POST /auth/logout`, `GET /auth/me`

**Files:**
- Create: `apps/api/src/routes/authMe.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/tests/authMe.test.ts`

**Interfaces:**
- Consumes: `getUserBySessionToken`, `deleteSession`, `SESSION_COOKIE_NAME` (Task 2).
- Produces: `registerAuthMeRoutes(app: FastifyInstance): void` — registers `GET /auth/me`
  (returns `{ id, email, name }` with 200, or `{ error: "not signed in" }` with 401) and
  `POST /auth/logout` (clears the session cookie and deletes the `sessions` row; always 200,
  even if there was no session to clear).

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/authMe.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

describe("GET /auth/me", () => {
  it("returns 401 with no session cookie", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/auth/me" });
    expect(response.statusCode).toBe(401);
  });

  it("returns the signed-in user for a valid session", async () => {
    const { db, pool } = await import("engine/db/client");
    const { users } = await import("engine/db/schema");
    const { createSession } = await import("../src/auth/session");
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-1", email: "a@example.com", name: "A" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: `oneabobeall_session=${token}` } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: user.id, email: "a@example.com", name: "A" });

    const { eq } = await import("drizzle-orm");
    await db.delete(users).where(eq(users.id, user.id));
    await pool.end();
  });
});

describe("POST /auth/logout", () => {
  it("clears the session cookie and the sessions row", async () => {
    const { db, pool } = await import("engine/db/client");
    const { users, sessions } = await import("engine/db/schema");
    const { createSession } = await import("../src/auth/session");
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-2", email: "b@example.com", name: "B" }).returning();
    const { token } = await createSession(user.id);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: `oneabobeall_session=${token}` } });

    expect(response.statusCode).toBe(200);
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(sessions).where(eq(sessions.token, token));
    expect(rows).toHaveLength(0);

    await db.delete(users).where(eq(users.id, user.id));
    await pool.end();
  });

  it("is a safe no-op with no session cookie", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/auth/logout" });
    expect(response.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace=apps/api -- authMe.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Create `apps/api/src/routes/authMe.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { getUserBySessionToken, deleteSession, SESSION_COOKIE_NAME } from "../auth/session";

export function registerAuthMeRoutes(app: FastifyInstance): void {
  app.get("/auth/me", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    const user = token ? await getUserBySessionToken(token) : null;
    if (!user) {
      reply.code(401);
      return { error: "not signed in" };
    }
    return user;
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (token) {
      await deleteSession(token);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return { loggedOut: true };
  });
}
```

- [ ] **Step 4: Wire into `server.ts`**

```ts
import { registerAuthMeRoutes } from "./routes/authMe";
```

```ts
  registerAuthMeRoutes(app);
```

- [ ] **Step 5: Run tests**

Run: `npm test --workspace=apps/api -- authMe.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/authMe.ts apps/api/src/server.ts apps/api/tests/authMe.test.ts
git commit -m "feat(api): add GET /auth/me and POST /auth/logout"
```

---

### Task 6: Require a session on `/rounds/:id/join` and `/bids`; add `GET /rounds/:id/me`

**Files:**
- Create: `apps/api/src/auth/requireSession.ts`
- Modify: `apps/api/src/routes/joinRound.ts`
- Modify: `apps/api/src/routes/placeBid.ts`
- Create: `apps/api/src/routes/roundParticipation.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/tests/joinRound.test.ts` (update)
- Test: `apps/api/tests/placeBid.test.ts` (update)
- Test: `apps/api/tests/roundParticipation.test.ts` (new)

**Why this task exists:** the just-completed Stripe plan's final review flagged, as an explicit
go-live gate, that these two money-moving routes trust a client-supplied `bidderId` with no
authentication at all. Section A of this plan (Tasks 1-5) now provides exactly the missing
piece — a real, server-issued session. This task closes that gap by deriving `bidderId` from the
signed-in user's session instead of trusting the request body, and adds the one new read the
auction page needs: "has the signed-in user already joined this round."

**Interfaces:**
- Produces:
  - `requireSession(request: FastifyRequest, reply: FastifyReply): Promise<{ id: string; email: string; name: string } | null>`
    — looks up the session cookie; if valid, returns the user; if not, sets `reply.code(401)`
    and returns `null` (callers check for `null` and `return` immediately, matching this
    codebase's existing single-function-does-the-full-check style rather than a Fastify
    `preHandler` hook, so the 401 response shape stays identical to every other route's
    `{ error: string }` pattern).
  - `registerRoundParticipationRoute(app: FastifyInstance): void` — registers
    `GET /rounds/:id/me`, returning `{ joined: boolean }` (200) for the signed-in user, or 401
    if not signed in.
- Consumes: `getUserBySessionToken`, `SESSION_COOKIE_NAME` (Task 2); `getRoundParticipant`
  (`engine/db/repository`, already exists).

- [ ] **Step 1: Write the failing test for `requireSession`**

Create `apps/api/tests/auth/requireSession.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { db, pool } from "engine/db/client";
import { users } from "engine/db/schema";
import { createSession } from "../../src/auth/session";
import { requireSession } from "../../src/auth/requireSession";
import { eq } from "drizzle-orm";

describe("requireSession", () => {
  it("returns the user for a valid session cookie", async () => {
    const [user] = await db.insert(users).values({ provider: "google", providerId: "g-3", email: "c@example.com", name: "C" }).returning();
    const { token } = await createSession(user.id);

    const app = Fastify();
    app.register(fastifyCookie);
    app.get("/test", async (request, reply) => {
      const resolved = await requireSession(request, reply);
      return resolved ?? {};
    });

    const response = await app.inject({ method: "GET", url: "/test", headers: { cookie: `oneabobeall_session=${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: user.id });

    await db.delete(users).where(eq(users.id, user.id));
    await pool.end();
  });

  it("sets 401 and returns null with no session cookie", async () => {
    const app = Fastify();
    app.register(fastifyCookie);
    app.get("/test", async (request, reply) => {
      const resolved = await requireSession(request, reply);
      if (!resolved) return reply.send({ rejected: true });
      return resolved;
    });

    const response = await app.inject({ method: "GET", url: "/test" });
    expect(response.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace=apps/api -- requireSession.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `requireSession.ts`**

Create `apps/api/src/auth/requireSession.ts`:

```ts
import type { FastifyRequest, FastifyReply } from "fastify";
import { getUserBySessionToken, SESSION_COOKIE_NAME } from "./session";

export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ id: string; email: string; name: string } | null> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  const user = token ? await getUserBySessionToken(token) : null;
  if (!user) {
    reply.code(401);
    reply.send({ error: "not signed in" });
    return null;
  }
  return user;
}
```

- [ ] **Step 4: Run to verify `requireSession` tests pass**

Run: `npm test --workspace=apps/api -- requireSession.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Update `joinRound.ts` to derive `bidderId` from the session**

Replace the `bidderId` handling in `apps/api/src/routes/joinRound.ts`. The current signature
reads `const { bidderId } = request.body ?? {};` and 400s if it's missing/not a string — replace
that with a `requireSession` call, and remove `bidderId` from the request body type entirely
(the client no longer sends it). Full replacement for the route handler function body:

```ts
export function registerJoinRoundRoute(app: FastifyInstance, stripe: Stripe, currency: string): void {
  app.post<{ Params: { id: string } }>("/rounds/:id/join", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;
    const bidderId = user.id;
    const { id: roundId } = request.params;

    const reign = await getCurrentReign();
    if (!reign) {
      reply.code(404);
      return { error: "no active reign" };
    }

    const round = await getLatestRound(reign.id);
    if (!round || round.id !== roundId) {
      reply.code(404);
      return { error: "round not found or no longer current" };
    }

    const now = new Date();
    if (!isBiddingOpen(round, now)) {
      reply.code(409);
      return { error: "round is not open for joining" };
    }

    if (await isBanned(bidderId, now)) {
      reply.code(403);
      return { error: "bidder is banned" };
    }

    const existing = await getRoundParticipant(round.id, bidderId);
    if (existing) {
      reply.code(409);
      return { error: "already joined this round" };
    }

    const depositCents = calculateDeposit(reign.priceCents);

    const customer = await stripe.customers.create({ metadata: { bidderId } });

    const intent = await stripe.paymentIntents.create({
      amount: depositCents,
      currency,
      customer: customer.id,
      setup_future_usage: "off_session",
      metadata: { kind: "deposit", roundId: round.id, bidderId },
    });

    return { clientSecret: intent.client_secret, depositCents };
  });
}
```

Add `import { requireSession } from "../auth/requireSession";` to the top of the file, alongside
its existing imports. Everything else in the file (the other imports, the money/round-validation
logic) stays exactly as it is — only the `bidderId` source and the route's generic type
parameter change.

- [ ] **Step 6: Update `joinRound.test.ts` for the new auth requirement**

Replace `apps/api/tests/joinRound.test.ts` in full with:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildServer } from "../src/server";

const { createPaymentIntent, createCustomer } = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(async () => ({ client_secret: "pi_1_secret", id: "pi_1" })),
  createCustomer: vi.fn(async () => ({ id: "cus_1" })),
}));

vi.mock("engine/db/repository", () => ({
  getRoundParticipant: vi.fn(async () => null),
  getCurrentReign: vi.fn(async () => ({ id: "reign-1", occupantId: "champ", priceCents: 10_000, startedAt: new Date(), endedAt: null })),
  getLatestRound: vi.fn(async () => ({ id: "round-1", reignId: "reign-1", startsAt: new Date(), phase: "bidding" })),
  isBanned: vi.fn(async () => false),
}));

vi.mock("../src/stripeClient", () => ({
  stripe: { paymentIntents: { create: createPaymentIntent }, customers: { create: createCustomer } },
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

// bidderId is now derived from the session, not the request body — every
// test in this file signs in as "challenger" by default; the one test that
// needs a different bidder overrides this with mockResolvedValueOnce.
vi.mock("../src/auth/requireSession", () => ({
  requireSession: vi.fn(async () => ({ id: "challenger", email: "c@example.com", name: "C" })),
}));

describe("POST /rounds/:id/join", () => {
  beforeEach(() => {
    createPaymentIntent.mockClear();
    createCustomer.mockClear();
  });

  it("creates a deposit PaymentIntent and returns its client secret", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.clientSecret).toBe("pi_1_secret");
    expect(body.depositCents).toBe(1_000); // 10% of the reign's 10_000 priceCents
    expect(createCustomer).toHaveBeenCalledWith({ metadata: { bidderId: "challenger" } });
    expect(createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1_000,
        customer: "cus_1",
        setup_future_usage: "off_session",
        metadata: { kind: "deposit", roundId: "round-1", bidderId: "challenger" },
      }),
    );
  });

  it("returns 401 when not signed in", async () => {
    const { requireSession } = await import("../src/auth/requireSession");
    vi.mocked(requireSession).mockImplementationOnce(async (_req, reply) => {
      reply.code(401);
      reply.send({ error: "not signed in" });
      return null;
    });

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join" });
    expect(response.statusCode).toBe(401);
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects with 404 when there's no active reign", async () => {
    const { getCurrentReign } = await import("engine/db/repository");
    vi.mocked(getCurrentReign).mockResolvedValueOnce(null);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join" });
    expect(response.statusCode).toBe(404);
  });

  it("rejects with 409 when this bidder already joined this round", async () => {
    const { getRoundParticipant } = await import("engine/db/repository");
    vi.mocked(getRoundParticipant).mockResolvedValueOnce({
      id: "p1", roundId: "round-1", bidderId: "challenger", depositCents: 1_000, depositRef: "pi_0", paymentMethodRef: "pm_0", customerRef: "cus_0", depositStatus: "held", joinedAt: new Date(),
    } as any);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join" });
    expect(response.statusCode).toBe(409);
  });

  it("rejects with 404 when the :id in the URL doesn't match any round", async () => {
    const { getLatestRound } = await import("engine/db/repository");
    vi.mocked(getLatestRound).mockResolvedValueOnce(null);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/nonexistent-round/join" });
    expect(response.statusCode).toBe(404);
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects with 404 when the :id in the URL is a real round but not the current one", async () => {
    const { getLatestRound } = await import("engine/db/repository");
    vi.mocked(getLatestRound).mockResolvedValueOnce({ id: "round-2", reignId: "reign-1", startsAt: new Date(), phase: "bidding" } as any);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join" });
    expect(response.statusCode).toBe(404);
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it("defeats the duplicate-join bypass: varying :id between calls for the same bidder still gets a 404, not a second PaymentIntent", async () => {
    const { getLatestRound } = await import("engine/db/repository");
    vi.mocked(getLatestRound).mockResolvedValueOnce({ id: "round-1", reignId: "reign-1", startsAt: new Date(), phase: "bidding" } as any);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/some-other-id/join" });
    expect(response.statusCode).toBe(404);
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects with 409 when the round's bidding window has already elapsed", async () => {
    const { getLatestRound } = await import("engine/db/repository");
    vi.mocked(getLatestRound).mockResolvedValueOnce({
      id: "round-1",
      reignId: "reign-1",
      startsAt: new Date(Date.now() - 13 * 60 * 60 * 1000),
      phase: "bidding",
    } as any);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join" });

    expect(response.statusCode).toBe(409);
    expect(createPaymentIntent).not.toHaveBeenCalled();
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it("rejects with 409 when the round has already left the bidding phase", async () => {
    const { getLatestRound } = await import("engine/db/repository");
    vi.mocked(getLatestRound).mockResolvedValueOnce({
      id: "round-1",
      reignId: "reign-1",
      startsAt: new Date(),
      phase: "resolving",
    } as any);

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join" });

    expect(response.statusCode).toBe(409);
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects a banned bidder with 403 and takes no money", async () => {
    const { isBanned } = await import("engine/db/repository");
    const { requireSession } = await import("../src/auth/requireSession");
    vi.mocked(isBanned).mockResolvedValueOnce(true);
    vi.mocked(requireSession).mockResolvedValueOnce({ id: "banned-guy", email: "b@example.com", name: "B" });

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/rounds/round-1/join" });

    expect(response.statusCode).toBe(403);
    expect(createPaymentIntent).not.toHaveBeenCalled();
    expect(createCustomer).not.toHaveBeenCalled();
  });
});
```

The changes from the pre-existing file: every `payload: { bidderId: "..." }` is removed from
`app.inject(...)` calls (the route no longer reads a body at all), a `requireSession` mock is
added (defaulting to bidder `"challenger"`), the banned-bidder test now overrides that mock
instead of passing a different `bidderId` in the payload, the "already joined" test's inline
participant object gains the `customerRef` field the schema now requires, and the old "rejects a
missing bidderId with 400" test is replaced by "returns 401 when not signed in" (there is no
longer a body for a missing-field check to apply to).

- [ ] **Step 7: Update `placeBid.ts` to derive `bidderId` from the session**

Replace `apps/api/src/routes/placeBid.ts`'s body-parsing with the same pattern:

```ts
import type { FastifyInstance } from "fastify";
import { placeBid } from "engine/engine/placeBid";
import { requireSession } from "../auth/requireSession";

export function registerPlaceBidRoute(app: FastifyInstance): void {
  app.post<{ Body: { amountCents?: number } }>("/bids", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;

    const { amountCents } = request.body ?? {};
    if (typeof amountCents !== "number") {
      reply.code(400);
      return { error: "amountCents is required" };
    }

    const result = await placeBid({ bidderId: user.id, amountCents, now: new Date() });
    if (!result.ok) {
      reply.code(422);
      return { error: result.reason };
    }

    return { bidId: result.bidId };
  });
}
```

- [ ] **Step 8: Update `placeBid.test.ts` for the new auth requirement**

Replace `apps/api/tests/placeBid.test.ts` in full with:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("engine/engine/placeBid", () => ({
  placeBid: vi.fn(async () => ({ ok: true, bidId: "bid-1" })),
}));

// bidderId is now derived from the session, not the request body.
vi.mock("../src/auth/requireSession", () => ({
  requireSession: vi.fn(async () => ({ id: "challenger", email: "c@example.com", name: "C" })),
}));

describe("POST /bids", () => {
  it("places a bid and returns its id", async () => {
    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/bids",
      payload: { amountCents: 11_000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ bidId: "bid-1" });

    const { placeBid } = await import("engine/engine/placeBid");
    expect(placeBid).toHaveBeenCalledWith({ bidderId: "challenger", amountCents: 11_000, now: expect.any(Date) });
  });

  it("returns 401 when not signed in", async () => {
    const { requireSession } = await import("../src/auth/requireSession");
    vi.mocked(requireSession).mockImplementationOnce(async (_req, reply) => {
      reply.code(401);
      reply.send({ error: "not signed in" });
      return null;
    });

    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/bids", payload: { amountCents: 11_000 } });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a malformed body with 400", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "POST", url: "/bids", payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("returns 422 with the engine's reason when placeBid rejects the bid", async () => {
    const { placeBid } = await import("engine/engine/placeBid");
    vi.mocked(placeBid).mockResolvedValueOnce({ ok: false, reason: "Join this round (pay the deposit) before placing a bid." });

    const app = buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/bids",
      payload: { amountCents: 11_000 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain("Join this round");
  });
});
```

- [ ] **Step 9: Write the failing test for `GET /rounds/:id/me`**

Create `apps/api/tests/roundParticipation.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server";

vi.mock("../src/stripeClient", () => ({
  stripe: {},
  STRIPE_CURRENCY: "usd",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}));

vi.mock("../src/auth/requireSession", () => ({
  requireSession: vi.fn(async () => ({ id: "bidder-1", email: "a@example.com", name: "A" })),
}));

vi.mock("engine/db/repository", () => ({
  getRoundParticipant: vi.fn(async (_roundId: string, bidderId: string) =>
    bidderId === "bidder-1" ? { id: "p1", roundId: "round-1", bidderId: "bidder-1" } : null,
  ),
}));

describe("GET /rounds/:id/me", () => {
  it("returns joined: true when the signed-in user has a participant row", async () => {
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/rounds/round-1/me" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ joined: true });
  });

  it("returns joined: false when they don't", async () => {
    const { requireSession } = await import("../src/auth/requireSession");
    vi.mocked(requireSession).mockResolvedValueOnce({ id: "someone-else", email: "x@example.com", name: "X" });

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/rounds/round-1/me" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ joined: false });
  });

  it("returns 401 when not signed in", async () => {
    const { requireSession } = await import("../src/auth/requireSession");
    vi.mocked(requireSession).mockImplementationOnce(async (_req, reply) => {
      reply.code(401);
      reply.send({ error: "not signed in" });
      return null;
    });

    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/rounds/round-1/me" });
    expect(response.statusCode).toBe(401);
  });
});
```

- [ ] **Step 10: Run to verify it fails**

Run: `npm test --workspace=apps/api -- roundParticipation.test.ts`
Expected: FAIL

- [ ] **Step 11: Implement**

Create `apps/api/src/routes/roundParticipation.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { getRoundParticipant } from "engine/db/repository";
import { requireSession } from "../auth/requireSession";

export function registerRoundParticipationRoute(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>("/rounds/:id/me", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;

    const participant = await getRoundParticipant(request.params.id, user.id);
    return { joined: !!participant };
  });
}
```

- [ ] **Step 12: Wire into `server.ts`**

```ts
import { registerRoundParticipationRoute } from "./routes/roundParticipation";
```

```ts
  registerRoundParticipationRoute(app);
```

- [ ] **Step 13: Run tests**

Run: `npm test --workspace=apps/api`
Expected: PASS — the full suite, since this task modified two existing route files whose tests
needed updating. Confirm no other test file (e.g. `stripeWebhook.test.ts`) was affected — it
shouldn't be, since it doesn't call `/rounds/:id/join` or `/bids` directly.

Run: `npm run typecheck --workspace=apps/api`
Expected: clean.

- [ ] **Step 14: Commit**

```bash
git add apps/api/src/auth/requireSession.ts apps/api/src/routes/joinRound.ts apps/api/src/routes/placeBid.ts apps/api/src/routes/roundParticipation.ts apps/api/src/server.ts apps/api/tests/auth/requireSession.test.ts apps/api/tests/joinRound.test.ts apps/api/tests/placeBid.test.ts apps/api/tests/roundParticipation.test.ts
git commit -m "feat(api): require a session on /rounds/:id/join and /bids; add GET /rounds/:id/me"
```

---

### Task 7: Dashboard shell — `apps/web/account.astro` + `AccountShell.tsx`

**Files:**
- Create: `apps/web/src/pages/account.astro`
- Create: `apps/web/src/components/AccountShell.tsx`
- Test: `apps/web/tests/AccountShell.test.tsx`
- Modify: `apps/web/.env.example` (create if it doesn't exist)

**Interfaces:**
- Produces: `AccountShell` (default export, React component) — props
  `{ apiBaseUrl: string; children: React.ReactNode }`. Renders a "checking session…" state,
  then either redirects (via `window.location.href`) to `/` on a 401 from `GET /auth/me`, or
  renders a header (site mark + "Sign out" button calling `POST /auth/logout`) + simple nav
  (Auction, Leaderboard) + `children`.

**Before this task, read `apps/web/src/components/AuctionFlow.tsx` in full** (already read
during this plan's brainstorm — re-read it now if resuming this task cold) to match its style
conventions exactly: inline `React.CSSProperties` objects for styling, the design tokens from
`apps/web/src/styles/tokens.css` (`--void`, `--gold`, `--panel`, `--line`, `--fg`, `--fg-dim`,
Cormorant Garamond for headings/numbers, Manrope for body text via the page's default font).

- [ ] **Step 1: Check/create `apps/web/.env.example`**

If `apps/web/.env.example` doesn't already exist, create it:

```
API_BASE_URL=http://127.0.0.1:3001
```

If it already exists (check first — it may already have `API_BASE_URL` from the prior Stripe
plan's `index.astro` work, which reads `import.meta.env.API_BASE_URL`), leave it as-is.

- [ ] **Step 2: Write the failing test**

Create `apps/web/tests/AccountShell.test.tsx`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import AccountShell from "../src/components/AccountShell";

afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error test override
  delete window.location;
  // @ts-expect-error test override
  window.location = { href: "" };
});

describe("AccountShell", () => {
  it("shows a loading state before the session check resolves", () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<AccountShell apiBaseUrl="http://api.test"><div>content</div></AccountShell>);
    expect(screen.getByText(/checking/i)).toBeInTheDocument();
  });

  it("redirects to / when the session check returns 401", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    render(<AccountShell apiBaseUrl="http://api.test"><div>content</div></AccountShell>);
    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it("renders the header, nav, and children when signed in", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "u1", email: "a@example.com", name: "A" }) })) as unknown as typeof fetch;
    render(<AccountShell apiBaseUrl="http://api.test"><div>account content</div></AccountShell>);
    await waitFor(() => expect(screen.getByText("account content")).toBeInTheDocument());
    expect(screen.getByText("Sign out")).toBeInTheDocument();
    expect(screen.getByText("Auction")).toBeInTheDocument();
    expect(screen.getByText("Leaderboard")).toBeInTheDocument();
  });

  it("calls fetch with credentials: include for the session check", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "u1", email: "a@example.com", name: "A" }) }));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<AccountShell apiBaseUrl="http://api.test"><div>content</div></AccountShell>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("http://api.test/auth/me", { credentials: "include" }));
  });

  it("sign out calls POST /auth/logout with credentials and redirects to /", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, status: 200, json: async () => ({ loggedOut: true }) };
      return { ok: true, status: 200, json: async () => ({ id: "u1", email: "a@example.com", name: "A" }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<AccountShell apiBaseUrl="http://api.test"><div>content</div></AccountShell>);
    await waitFor(() => expect(screen.getByText("Sign out")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Sign out"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("http://api.test/auth/logout", { method: "POST", credentials: "include" }));
    await waitFor(() => expect(window.location.href).toBe("/"));
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test --workspace=apps/web -- AccountShell.test.tsx`
Expected: FAIL

- [ ] **Step 4: Implement**

Create `apps/web/src/components/AccountShell.tsx`:

```tsx
import { useEffect, useState } from "react";

type SessionUser = { id: string; email: string; name: string };
type Status = "checking" | "signed-in" | "redirecting";

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "18px 24px",
  borderBottom: "1px solid var(--line)",
};

const navStyle: React.CSSProperties = {
  display: "flex",
  gap: 18,
  fontSize: 12,
  letterSpacing: ".12em",
  textTransform: "uppercase",
  color: "var(--fg-dim)",
};

const chromeButtonStyle: React.CSSProperties = {
  padding: "8px 13px",
  fontSize: 10,
  letterSpacing: ".18em",
  textTransform: "uppercase",
  color: "var(--fg-dim)",
  border: "1px solid var(--line)",
  background: "var(--panel-2)",
};

export default function AccountShell({
  apiBaseUrl,
  children,
}: {
  apiBaseUrl: string;
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    fetch(`${apiBaseUrl}/auth/me`, { credentials: "include" })
      .then((res) => {
        if (!res.ok) {
          setStatus("redirecting");
          window.location.href = "/";
          return;
        }
        setStatus("signed-in");
      })
      .catch(() => {
        setStatus("redirecting");
        window.location.href = "/";
      });
  }, [apiBaseUrl]);

  function signOut() {
    fetch(`${apiBaseUrl}/auth/logout`, { method: "POST", credentials: "include" }).finally(() => {
      window.location.href = "/";
    });
  }

  if (status !== "signed-in") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-dim)" }}>
        Checking session…
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--void)", color: "var(--fg)" }}>
      <div style={headerStyle}>
        <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 20 }}>oneabobeall</div>
        <div style={navStyle}>
          <a href="/account/auction">Auction</a>
          <a href="/account/leaderboard">Leaderboard</a>
        </div>
        <button onClick={signOut} style={chromeButtonStyle}>
          Sign out
        </button>
      </div>
      <div style={{ padding: 24 }}>{children}</div>
    </div>
  );
}
```

- [ ] **Step 5: Create the Astro page**

Create `apps/web/src/pages/account.astro`:

```astro
---
import BaseLayout from "../layouts/BaseLayout.astro";
import AccountShell from "../components/AccountShell";

const apiBaseUrl = import.meta.env.API_BASE_URL ?? "http://127.0.0.1:3001";
---
<BaseLayout title="oneabobeall — Account">
  <AccountShell client:load apiBaseUrl={apiBaseUrl}>
    <p>Welcome to your account.</p>
  </AccountShell>
</BaseLayout>
```

- [ ] **Step 6: Run tests**

Run: `npm test --workspace=apps/web -- AccountShell.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/account.astro apps/web/src/components/AccountShell.tsx apps/web/tests/AccountShell.test.tsx apps/web/.env.example
git commit -m "feat(web): add the personal account dashboard shell"
```

---

### Task 8: `GET /current-round` short-TTL cache

**Files:**
- Modify: `apps/api/src/routes/currentRound.ts`
- Test: `apps/api/tests/currentRound.test.ts`

**Interfaces:**
- Produces: same `registerCurrentRoundRoute(app: FastifyInstance): void` signature — behavior
  unchanged from the caller's perspective, just cached for up to 1.5s per process.

- [ ] **Step 1: Add a cache-reset hook so this task's caching doesn't leak between the file's other tests**

The route's new cache is process-wide module state — without a reset, whichever test runs first
populates it, and every test after it (within the TTL, which easily spans a whole fast test
file run) would silently receive that first test's cached response instead of exercising its
own mock. This would break the file's two pre-existing tests
(`returns the current round info as JSON` / `returns null ... when there's no active reign`),
not just anything new added here.

Add the import and a `beforeEach` to the top of `apps/api/tests/currentRound.test.ts`, right
after its existing imports (do not remove or reorder anything already there):

```ts
import { beforeEach } from "vitest";
import { __resetCacheForTests } from "../src/routes/currentRound";

beforeEach(() => {
  __resetCacheForTests();
});
```

- [ ] **Step 2: Write the failing test**

Append to `apps/api/tests/currentRound.test.ts` (inside the existing `describe("GET /current-round", ...)` block — this file already exists from the prior plan):

```ts
  it("caches the result for concurrent requests within the TTL — the engine query runs only once", async () => {
    const { getCurrentRoundInfo } = await import("engine/queries/publicScene");
    vi.mocked(getCurrentRoundInfo).mockClear();
    vi.mocked(getCurrentRoundInfo).mockResolvedValue({
      roundId: "round-1",
      phase: "bidding",
      currentLeaderCents: 100_000,
      depositCents: 10_000,
      biddingClosesAt: new Date("2026-09-23T12:00:00.000Z"),
    });

    const app = buildServer();
    const [first, second] = await Promise.all([
      app.inject({ method: "GET", url: "/current-round" }),
      app.inject({ method: "GET", url: "/current-round" }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(vi.mocked(getCurrentRoundInfo)).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test --workspace=apps/api -- currentRound.test.ts`
Expected: FAIL (no caching yet, `getCurrentRoundInfo` called twice; also fails to import
`__resetCacheForTests`, which doesn't exist yet)

- [ ] **Step 4: Implement**

Replace `apps/api/src/routes/currentRound.ts` with:

```ts
import type { FastifyInstance } from "fastify";
import { getCurrentRoundInfo } from "engine/queries/publicScene";

const CACHE_TTL_MS = 1_500;

// Many browser tabs poll this route every 5-10s (see the frontend design
// spec's Performance & Scale section). A short in-process cache collapses
// concurrent pollers within the TTL into a single DB round-trip instead of
// one getCurrentReign/getLatestRound/getQueueLeader sequence per request.
// Deliberately per-process, not shared/distributed — safe to run as
// multiple apps/api instances later without any coordination between them.
let cached: { value: Awaited<ReturnType<typeof getCurrentRoundInfo>>; expiresAt: number } | null = null;
let pending: Promise<Awaited<ReturnType<typeof getCurrentRoundInfo>>> | null = null;

async function getCachedCurrentRoundInfo() {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  if (!pending) {
    pending = getCurrentRoundInfo(new Date()).then((value) => {
      cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
      pending = null;
      return value;
    });
  }
  return pending;
}

// Test-only: clears the module-level cache so each test starts from a clean
// slate instead of silently inheriting whatever an earlier test in the same
// file run happened to cache. Exported (not module-private) specifically so
// apps/api/tests/currentRound.test.ts's beforeEach (Step 1) can call it —
// this cache is otherwise invisible/unreachable from outside the module.
export function __resetCacheForTests(): void {
  cached = null;
  pending = null;
}

export function registerCurrentRoundRoute(app: FastifyInstance): void {
  app.get("/current-round", async () => {
    return getCachedCurrentRoundInfo();
  });
}
```

- [ ] **Step 5: Run tests**

Run: `npm test --workspace=apps/api -- currentRound.test.ts`
Expected: PASS — including the two pre-existing tests from the prior plan, which now get a
clean cache thanks to Step 1's `beforeEach`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/currentRound.ts apps/api/tests/currentRound.test.ts
git commit -m "perf(api): cache GET /current-round for 1.5s to collapse concurrent pollers"
```

---

### Task 9: Auction page skeleton — live polling, Join-vs-Bid branching

**Files:**
- Create: `apps/web/src/pages/account/auction.astro`
- Create: `apps/web/src/components/LiveAuction.tsx`
- Test: `apps/web/tests/LiveAuction.test.tsx`

**Interfaces:**
- Produces: `LiveAuction` (default export, React component) — props `{ apiBaseUrl: string }`.
  Internally polls `GET /current-round` (visibility-aware) and, once it knows the current
  `roundId`, `GET /rounds/:id/me` to learn whether the signed-in user has joined. Renders one of
  three states: loading, "not joined" (a Join card — Stripe wiring lands in Task 10), or
  "joined" (a bid form — wiring lands in Task 11). This task builds the polling/branching
  skeleton with both cards as static placeholders; Tasks 10-11 make them functional.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/LiveAuction.test.tsx`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import LiveAuction from "../src/components/LiveAuction";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mockFetchSequence(responses: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/current-round") return { ok: true, json: async () => responses.currentRound };
    if (path.match(/^\/rounds\/.+\/me$/)) return { ok: true, json: async () => responses.participation };
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("LiveAuction", () => {
  it("shows a loading state before the first fetch resolves", () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows the Join card when the signed-in user hasn't joined", async () => {
    global.fetch = mockFetchSequence({
      currentRound: { roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" },
      participation: { joined: false },
    }) as unknown as typeof fetch;
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText(/join/i)).toBeInTheDocument());
    expect(screen.getByText("$100")).toBeInTheDocument(); // depositCents: 10_000 -> formatMoney -> "$100"
  });

  it("shows the bid form when the signed-in user has already joined", async () => {
    global.fetch = mockFetchSequence({
      currentRound: { roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" },
      participation: { joined: true },
    }) as unknown as typeof fetch;
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());
  });

  it("shows a null-round state when there's no active reign yet", async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (new URL(url).pathname === "/current-round") return { ok: true, json: async () => null };
      throw new Error("should not call /rounds/:id/me with no round");
    }) as unknown as typeof fetch;
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText(/no active round/i)).toBeInTheDocument());
  });

  it("re-polls /current-round every 5s while the tab is visible", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence({
      currentRound: { roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" },
      participation: { joined: false },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsAfterMount = fetchMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("pauses polling when the tab is hidden and resumes on visible", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence({
      currentRound: { roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" },
      participation: { joined: false },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    const callsWhileHidden = fetchMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsWhileHidden); // no new calls while hidden

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsWhileHidden); // an immediate re-fetch on becoming visible
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace=apps/web -- LiveAuction.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement**

Create `apps/web/src/components/LiveAuction.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { formatMoney } from "../lib/format";

type CurrentRoundInfo = {
  roundId: string;
  phase: "bidding" | "resolving" | "payment" | "closed";
  currentLeaderCents: number;
  depositCents: number;
  biddingClosesAt: string;
} | null;

const POLL_INTERVAL_MS = 5_000;

const boxStyle: React.CSSProperties = {
  padding: "20px 22px",
  border: "1px solid var(--line)",
  background: "var(--panel-2)",
  maxWidth: 420,
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: ".16em",
  textTransform: "uppercase",
  color: "var(--fg-faint)",
};

const primaryButtonStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 18,
  padding: 16,
  background: "var(--gold)",
  color: "var(--btn-fg)",
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: ".28em",
  textTransform: "uppercase",
};

export default function LiveAuction({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [round, setRound] = useState<CurrentRoundInfo | "loading">("loading");
  const [joined, setJoined] = useState<boolean | null>(null);
  const roundIdRef = useRef<string | null>(null);

  async function poll() {
    const res = await fetch(`${apiBaseUrl}/current-round`, { credentials: "include" });
    const data: CurrentRoundInfo = await res.json();
    setRound(data);

    if (data && data.roundId !== roundIdRef.current) {
      roundIdRef.current = data.roundId;
      const meRes = await fetch(`${apiBaseUrl}/rounds/${data.roundId}/me`, { credentials: "include" });
      const meData = await meRes.json();
      setJoined(!!meData.joined);
    } else if (!data) {
      roundIdRef.current = null;
      setJoined(null);
    }
  }

  useEffect(() => {
    poll();

    let intervalId: ReturnType<typeof setInterval> | null = null;

    function startPolling() {
      if (intervalId) return;
      intervalId = setInterval(poll, POLL_INTERVAL_MS);
    }
    function stopPolling() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        stopPolling();
      } else {
        poll();
        startPolling();
      }
    }

    startPolling();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl]);

  if (round === "loading") {
    return <div style={{ color: "var(--fg-dim)" }}>Loading…</div>;
  }

  if (!round) {
    return <div style={{ color: "var(--fg-dim)" }}>No active round right now.</div>;
  }

  if (joined === null) {
    return <div style={{ color: "var(--fg-dim)" }}>Loading…</div>;
  }

  if (!joined) {
    return (
      <div style={boxStyle}>
        <div style={fieldLabelStyle}>Deposit to join this round</div>
        <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 34, marginTop: 6 }}>
          {formatMoney(round.depositCents)}
        </div>
        <button style={primaryButtonStyle}>Join</button>
      </div>
    );
  }

  return (
    <div style={boxStyle}>
      <div style={fieldLabelStyle}>Current leader</div>
      <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 28, marginTop: 6 }}>
        {formatMoney(round.currentLeaderCents)}
      </div>
      <div style={{ marginTop: 18 }}>
        <label htmlFor="live-auction-bid" style={fieldLabelStyle}>
          Your bid, $
        </label>
        <input id="live-auction-bid" type="text" style={{ display: "block", width: "100%", marginTop: 8, padding: "12px 14px", background: "transparent", border: "1px solid var(--gold-soft)", color: "var(--fg)" }} />
      </div>
      <button style={primaryButtonStyle}>Place bid</button>
    </div>
  );
}
```

- [ ] **Step 4: Create the Astro page**

Create `apps/web/src/pages/account/auction.astro`:

```astro
---
import BaseLayout from "../../layouts/BaseLayout.astro";
import AccountShell from "../../components/AccountShell";
import LiveAuction from "../../components/LiveAuction";

const apiBaseUrl = import.meta.env.API_BASE_URL ?? "http://127.0.0.1:3001";
---
<BaseLayout title="oneabobeall — Auction">
  <AccountShell client:load apiBaseUrl={apiBaseUrl}>
    <LiveAuction client:load apiBaseUrl={apiBaseUrl} />
  </AccountShell>
</BaseLayout>
```

- [ ] **Step 5: Run tests**

Run: `npm test --workspace=apps/web -- LiveAuction.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/account/auction.astro apps/web/src/components/LiveAuction.tsx apps/web/tests/LiveAuction.test.tsx
git commit -m "feat(web): add the live auction page — polling and Join/Bid branching skeleton"
```

---

### Task 10: Stripe Elements — the Join flow

**Files:**
- Modify: `apps/web/src/components/LiveAuction.tsx`
- Modify: `apps/web/package.json` (add `@stripe/stripe-js`, `@stripe/react-stripe-js`)
- Modify: `apps/web/.env.example`
- Test: `apps/web/tests/LiveAuction.test.tsx` (extend)

**Interfaces:**
- Consumes: `POST /rounds/:id/join` (Task 6, session-authenticated, no body needed now).
- Produces: the "not joined" branch of `LiveAuction` becomes functional — clicking "Join" calls
  `POST /rounds/:id/join`, then mounts a Stripe `<Elements>`/`<PaymentElement>` form using the
  returned `clientSecret`, confirms the payment via `stripe.confirmPayment`, and on success polls
  `GET /rounds/:id/me` until `joined: true` (the webhook-driven join can land slightly after the
  client-side confirmation).

- [ ] **Step 1: Add dependencies**

Add to `apps/web/package.json`'s `"dependencies"`:

```json
    "@stripe/stripe-js": "^4.8.0",
    "@stripe/react-stripe-js": "^2.8.1",
```

Run: `npm install --workspace=apps/web`

- [ ] **Step 2: Add the publishable key env var**

Add to `apps/web/.env.example`:

```
STRIPE_PUBLISHABLE_KEY=pk_test_...
```

- [ ] **Step 3: Write the failing test**

Extend `apps/web/tests/LiveAuction.test.tsx` — mock `@stripe/stripe-js` and
`@stripe/react-stripe-js` at the top of the file:

```ts
vi.mock("@stripe/stripe-js", () => ({
  loadStripe: vi.fn(async () => ({
    confirmPayment: vi.fn(async () => ({ error: undefined })),
  })),
}));

vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmPayment: vi.fn(async () => ({ error: undefined })) }),
  useElements: () => ({}),
}));
```

Add to the `describe("LiveAuction", ...)` block:

```ts
  it("clicking Join creates a PaymentIntent and mounts the Stripe payment form", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/current-round") return { ok: true, json: async () => ({ roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" }) };
      if (path === "/rounds/round-1/me") return { ok: true, json: async () => ({ joined: false }) };
      if (path === "/rounds/round-1/join" && init?.method === "POST") return { ok: true, json: async () => ({ clientSecret: "pi_1_secret_x", depositCents: 10_000 }) };
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { fireEvent, screen, waitFor } = await import("@testing-library/react");
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByText("Join")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Join"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("http://api.test/rounds/round-1/join", { method: "POST", credentials: "include" }));
    await waitFor(() => expect(screen.getByTestId("payment-element")).toBeInTheDocument());
  });
```

`render` is already imported at the top of the test file (from Task 9); `fireEvent` is not — the
dynamic `await import("@testing-library/react")` above gets it (and re-gets `screen`/`waitFor`,
harmlessly — a dynamic import resolves to the same module instance) without needing to touch the
existing top-level import line.

- [ ] **Step 4: Run to verify it fails**

Run: `npm test --workspace=apps/web -- LiveAuction.test.tsx`
Expected: FAIL

- [ ] **Step 5: Implement**

Replace `apps/web/src/components/LiveAuction.tsx` in full:

```tsx
import { useEffect, useRef, useState } from "react";
import { loadStripe, type Stripe as StripeClient } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { formatMoney } from "../lib/format";

type CurrentRoundInfo = {
  roundId: string;
  phase: "bidding" | "resolving" | "payment" | "closed";
  currentLeaderCents: number;
  depositCents: number;
  biddingClosesAt: string;
} | null;

const POLL_INTERVAL_MS = 5_000;

const boxStyle: React.CSSProperties = {
  padding: "20px 22px",
  border: "1px solid var(--line)",
  background: "var(--panel-2)",
  maxWidth: 420,
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: ".16em",
  textTransform: "uppercase",
  color: "var(--fg-faint)",
};

const primaryButtonStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 18,
  padding: 16,
  background: "var(--gold)",
  color: "var(--btn-fg)",
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: ".28em",
  textTransform: "uppercase",
};

let stripePromise: Promise<StripeClient | null> | null = null;
function getStripe(): Promise<StripeClient | null> {
  if (!stripePromise) {
    stripePromise = loadStripe(import.meta.env.STRIPE_PUBLISHABLE_KEY ?? "");
  }
  return stripePromise;
}

function JoinPaymentForm({ apiBaseUrl, roundId, onJoined }: { apiBaseUrl: string; roundId: string; onJoined: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const { error: confirmError } = await stripe.confirmPayment({ elements, redirect: "if_required" });
    if (confirmError) {
      setError(confirmError.message ?? "Payment failed.");
      setSubmitting(false);
      return;
    }

    // The deposit is confirmed on the client, but joinRound runs from the
    // webhook, which can land a moment after this — poll /rounds/:id/me until
    // it reflects the join rather than assuming it's instant.
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await fetch(`${apiBaseUrl}/rounds/${roundId}/me`, { credentials: "include" });
      const data = await res.json();
      if (data.joined) {
        onJoined();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    setError("Payment succeeded, but joining is taking longer than expected — refresh in a moment.");
    setSubmitting(false);
  }

  return (
    <div style={{ marginTop: 18 }}>
      <PaymentElement />
      {error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-dim)" }}>{error}</div>}
      <button onClick={handleConfirm} disabled={submitting} style={primaryButtonStyle}>
        {submitting ? "Confirming…" : "Confirm payment"}
      </button>
    </div>
  );
}

export default function LiveAuction({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [round, setRound] = useState<CurrentRoundInfo | "loading">("loading");
  const [joined, setJoined] = useState<boolean | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const roundIdRef = useRef<string | null>(null);

  async function poll() {
    const res = await fetch(`${apiBaseUrl}/current-round`, { credentials: "include" });
    const data: CurrentRoundInfo = await res.json();
    setRound(data);

    if (data && data.roundId !== roundIdRef.current) {
      roundIdRef.current = data.roundId;
      const meRes = await fetch(`${apiBaseUrl}/rounds/${data.roundId}/me`, { credentials: "include" });
      const meData = await meRes.json();
      setJoined(!!meData.joined);
    } else if (!data) {
      roundIdRef.current = null;
      setJoined(null);
    }
  }

  useEffect(() => {
    poll();

    let intervalId: ReturnType<typeof setInterval> | null = null;

    function startPolling() {
      if (intervalId) return;
      intervalId = setInterval(poll, POLL_INTERVAL_MS);
    }
    function stopPolling() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        stopPolling();
      } else {
        poll();
        startPolling();
      }
    }

    startPolling();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl]);

  async function startJoin() {
    if (!round) return;
    const res = await fetch(`${apiBaseUrl}/rounds/${round.roundId}/join`, { method: "POST", credentials: "include" });
    const data = await res.json();
    setClientSecret(data.clientSecret);
  }

  if (round === "loading") {
    return <div style={{ color: "var(--fg-dim)" }}>Loading…</div>;
  }

  if (!round) {
    return <div style={{ color: "var(--fg-dim)" }}>No active round right now.</div>;
  }

  if (joined === null) {
    return <div style={{ color: "var(--fg-dim)" }}>Loading…</div>;
  }

  if (!joined) {
    return (
      <div style={boxStyle}>
        <div style={fieldLabelStyle}>Deposit to join this round</div>
        <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 34, marginTop: 6 }}>
          {formatMoney(round.depositCents)}
        </div>
        {clientSecret ? (
          <Elements stripe={getStripe()} options={{ clientSecret }}>
            <JoinPaymentForm apiBaseUrl={apiBaseUrl} roundId={round.roundId} onJoined={() => setJoined(true)} />
          </Elements>
        ) : (
          <button onClick={startJoin} style={primaryButtonStyle}>
            Join
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={boxStyle}>
      <div style={fieldLabelStyle}>Current leader</div>
      <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 28, marginTop: 6 }}>
        {formatMoney(round.currentLeaderCents)}
      </div>
      <div style={{ marginTop: 18 }}>
        <label htmlFor="live-auction-bid" style={fieldLabelStyle}>
          Your bid, $
        </label>
        <input id="live-auction-bid" type="text" style={{ display: "block", width: "100%", marginTop: 8, padding: "12px 14px", background: "transparent", border: "1px solid var(--gold-soft)", color: "var(--fg)" }} />
      </div>
      <button style={primaryButtonStyle}>Place bid</button>
    </div>
  );
}
```

- [ ] **Step 6: Run tests**

Run: `npm test --workspace=apps/web -- LiveAuction.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/LiveAuction.tsx apps/web/package.json apps/web/package-lock.json apps/web/.env.example apps/web/tests/LiveAuction.test.tsx
git commit -m "feat(web): wire Stripe Elements into the Join flow"
```

---

### Task 11: Bid submission wiring

**Files:**
- Modify: `apps/web/src/components/LiveAuction.tsx`
- Test: `apps/web/tests/LiveAuction.test.tsx` (extend)

**Interfaces:**
- Consumes: `POST /bids` (Task 6, session-authenticated, body `{ amountCents }`).
- Produces: the "joined" branch's bid input + "Place bid" button becomes functional.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/tests/LiveAuction.test.tsx`:

```ts
  it("submitting a bid calls POST /bids and shows a confirmation", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/current-round") return { ok: true, json: async () => ({ roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" }) };
      if (path === "/rounds/round-1/me") return { ok: true, json: async () => ({ joined: true }) };
      if (path === "/bids" && init?.method === "POST") return { ok: true, json: async () => ({ bidId: "bid-1" }) };
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { fireEvent, screen, waitFor } = await import("@testing-library/react");
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "1500" } });
    fireEvent.click(screen.getByText("Place bid"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("http://api.test/bids", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents: 150_000 }),
      }),
    );
    await waitFor(() => expect(screen.getByText(/bid placed/i)).toBeInTheDocument());
  });

  it("shows the engine's rejection reason when a bid is invalid", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/current-round") return { ok: true, json: async () => ({ roundId: "round-1", phase: "bidding", currentLeaderCents: 100_000, depositCents: 10_000, biddingClosesAt: "2026-09-23T12:00:00.000Z" }) };
      if (path === "/rounds/round-1/me") return { ok: true, json: async () => ({ joined: true }) };
      if (path === "/bids" && init?.method === "POST") return { ok: false, status: 422, json: async () => ({ error: "Bid must be at least $1 above the current leader." }) };
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { fireEvent, screen, waitFor } = await import("@testing-library/react");
    render(<LiveAuction apiBaseUrl="http://api.test" />);
    await waitFor(() => expect(screen.getByLabelText(/your bid/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/your bid/i), { target: { value: "500" } });
    fireEvent.click(screen.getByText("Place bid"));

    await waitFor(() => expect(screen.getByText("Bid must be at least $1 above the current leader.")).toBeInTheDocument());
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace=apps/web -- LiveAuction.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement**

Replace the "joined" branch's return block at the end of `apps/web/src/components/LiveAuction.tsx`
(the final `return (...)` in the `LiveAuction` component, currently a static bid input +
disconnected button) with a new sub-component and its usage:

Add this component above `LiveAuction`'s own definition (after `JoinPaymentForm`):

```tsx
function BidForm({ apiBaseUrl, currentLeaderCents }: { apiBaseUrl: string; currentLeaderCents: number }) {
  const [bidValue, setBidValue] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "placed">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submitBid() {
    const digits = bidValue.replace(/[^\d]/g, "");
    const amountCents = digits === "" ? 0 : Number(digits) * 100;
    setStatus("submitting");
    setError(null);

    const res = await fetch(`${apiBaseUrl}/bids`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountCents }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Bid was rejected.");
      setStatus("idle");
      return;
    }

    setStatus("placed");
  }

  return (
    <>
      <div style={{ marginTop: 18 }}>
        <label htmlFor="live-auction-bid" style={fieldLabelStyle}>
          Your bid, $
        </label>
        <input
          id="live-auction-bid"
          type="text"
          value={bidValue}
          onChange={(e) => setBidValue(e.target.value)}
          style={{ display: "block", width: "100%", marginTop: 8, padding: "12px 14px", background: "transparent", border: "1px solid var(--gold-soft)", color: "var(--fg)" }}
        />
      </div>
      {error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-dim)" }}>{error}</div>}
      {status === "placed" && <div style={{ marginTop: 10, fontSize: 12, color: "var(--gold)" }}>Bid placed — you can raise it again any time.</div>}
      <button onClick={submitBid} disabled={status === "submitting"} style={primaryButtonStyle}>
        {status === "submitting" ? "Placing…" : "Place bid"}
      </button>
    </>
  );
}
```

Then replace the final `return (...)` block inside `LiveAuction` (the "joined" state) with:

```tsx
  return (
    <div style={boxStyle}>
      <div style={fieldLabelStyle}>Current leader</div>
      <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 28, marginTop: 6 }}>
        {formatMoney(round.currentLeaderCents)}
      </div>
      <BidForm apiBaseUrl={apiBaseUrl} currentLeaderCents={round.currentLeaderCents} />
    </div>
  );
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=apps/web -- LiveAuction.test.tsx`
Expected: PASS (all tests in the file)

Then run the full `apps/web` suite to confirm nothing else broke:
`npm test --workspace=apps/web`

Run: `npm run typecheck --workspace=apps/web` (this project's `apps/web` typecheck script is
`astro check`, which also typechecks `.tsx` files it can reach from `.astro` pages)
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/LiveAuction.tsx apps/web/tests/LiveAuction.test.tsx
git commit -m "feat(web): wire free bid submission into the auction page"
```

---

## After This Plan

Still explicitly deferred, unrelated to this plan and not blocking it:

- The `upload`/`pending`/`missed` face-pipeline screens in the old `AuctionFlow.tsx` mock —
  untouched, belong to the still-unbuilt face-generation feature.
- Account linking/merging across OAuth providers.
- Rate limiting / bot protection on the auth or bidding routes.
- Deployment: standing up `apps/api` behind Traefik with real domain routing, provisioning the
  real Google/Apple/Stripe credentials in production, and everything in the earlier Stripe
  plan's own "After This Plan" section (k8s namespace, Postgres, secrets).
- The `apps/web` leaderboard page referenced by `AccountShell`'s nav
  (`/account/leaderboard`) doesn't exist yet as a real route in this plan — the nav link is
  present per the design, but building that page (likely just reusing the existing leaderboard
  screen's content/logic from `AuctionFlow.tsx`, moved into the account shell) is a natural,
  small follow-up, not included here to keep this plan's scope to what the user actually asked
  for (auth + auction page).
