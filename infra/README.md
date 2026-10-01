# Deployment

## Architecture

Runs on the same Hetzner k3s cluster as job-link-boil, in its own namespace
(`oneaboveall`) — nothing here touches the `job-link` namespace. Same
conventions as that project: Traefik ingress, cert-manager for TLS,
registry-free deploys (`docker build` locally → `docker save | sudo k3s ctr
images import -`), manual `deploy.sh`, no CI.

```
                         Traefik Ingress (TLS via cert-manager)
                          /                              \
              oneaboveall.org                    api.oneaboveall.org
                    |                                     |
          Service: oneaboveall-web              Service: oneaboveall-api
                    |                                     |
     ┌──────────────┴──────────────┐            Deployment: oneaboveall-api
     │  Deployment: oneaboveall-web │            (1 replica, PVC for photo
     │                              │             uploads, PVC for Apple
     │  init: build astro site      │             signing key)
     │        into shared volume    │                      |
     │  nginx        <───┐          │            setInterval → tick()
     │  (serves        shared       │            (apps/api/src/scheduler.ts)
     │   /shared/      emptyDir     │            closes bidding windows,
     │   current)        │          │            installs new champions
     │  web-rebuilder ───┘          │                      |
     │  (POST /rebuild,             │◄─────── POST /rebuild ┘
     │   rebuilds on demand)        │      (only when a new champion
     └──────────────────────────────┘       was just installed)
                    |
          Service: postgres (in-cluster, PVC-backed)
```

`apps/web` is `output: "static"` — its homepage is generated once, at
`astro build` time, from `/scene` and `/leaderboard`. It does **not**
re-render itself. The champion only actually changes when a bidding window
closes (`apps/engine/src/engine/roundResolution.ts`), which happens rarely
(once per round, not once per bid) — so `apps/api`'s scheduler triggers a
fresh, few-second static rebuild through the `web-rebuilder` sidecar exactly
at that moment, instead of waiting for the next full deploy. See
`infra/docker/rebuild-server.mjs`'s header comment for the full mechanism.

The countdown and current price are unaffected by any of this — they're
already fetched live from `GET /current-round` by the client (see
`AuctionFlow.tsx`), independent of the static build.

## One-time prerequisites

1. **kubeconfig**: copy the cluster's kubeconfig to `infra/secrets/kubeconfig`
   (gitignored — never commit it).
2. **Verify the cert-manager ClusterIssuer name**:
   ```bash
   export KUBECONFIG=infra/secrets/kubeconfig
   kubectl get clusterissuer
   ```
   `infra/k8s/ingress.yaml` assumes `letsencrypt-prod`. If the cluster's
   issuer has a different name, edit the `cert-manager.io/cluster-issuer`
   annotation in that file before the first deploy.
3. **DNS**: point these at the VPS's public IP (A records, or AAAA if
   IPv6):
   - `oneaboveall.org`
   - `www.oneaboveall.org`
   - `api.oneaboveall.org`

   Give DNS a few minutes to propagate before the first deploy — the very
   first cert-manager issuance needs the domains to already resolve.

## Secrets

None of these are committed — `infra/secrets/` is gitignored.

### `infra/secrets/prod.env`

One `KEY=value` per line, consumed by `kubectl create secret generic
oneaboveall-secrets --from-env-file=...` (see `deploy.sh`). Every key here
becomes an environment variable on the `oneaboveall-api` container via
`envFrom`, **except** `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD`,
which only bootstrap the in-cluster Postgres container (`infra/k8s/postgres.yaml`)
— apps/api never reads those three directly, only `DATABASE_URL`. Keep them
consistent with each other manually; nothing derives one from the other.

```bash
# Postgres bootstrap — keep in sync with DATABASE_URL below
POSTGRES_DB=oneaboveall
POSTGRES_USER=oneaboveall
POSTGRES_PASSWORD=<generate a strong password>

# apps/engine / apps/api — host "postgres" is the in-cluster Service name,
# resolves within the oneaboveall namespace without any extra config
DATABASE_URL=postgres://oneaboveall:<same password as above>@postgres:5432/oneaboveall

# Stripe — LIVE keys, not test keys (this is production)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...   # from the live webhook endpoint, see below

# Must be the web origin exactly — no wildcard, no trailing slash. The API
# sends credentialed CORS responses (session cookie), which browsers reject
# outright against a wildcard origin (see server.ts's own comment).
CORS_ORIGIN=https://oneaboveall.org

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

APPLE_TEAM_ID=...
APPLE_KEY_ID=...
APPLE_SERVICES_ID=...
# Relative to the container's cwd (/app/apps/api) — this exact value, the
# file itself comes from infra/secrets/apple-private-key.p8 below, mounted
# by infra/k8s/api.yaml at that same relative path.
APPLE_PRIVATE_KEY_PATH=./apple-private-key.p8

PUBLIC_APP_URL=https://oneaboveall.org
API_PUBLIC_URL=https://api.oneaboveall.org

# Outbid / won emails (see "Email" below). Unset RESEND_API_KEY = emails are
# skipped (one warning in the api log), nothing else breaks.
RESEND_API_KEY=re_...
EMAIL_FROM=oneaboveall <noreply@oneaboveall.org>

# Bearer token for the operator-only /admin API (see "Operator runbook"
# below). Unset/empty = every /admin route 404s. Generate with
# `openssl rand -hex 32`; anyone holding it can read bidders' emails and
# photos, so treat it like the Stripe secret key.
ADMIN_TOKEN=<long random hex>
```

Register `https://api.oneaboveall.org/auth/google/callback` and
`https://api.oneaboveall.org/auth/apple/callback` as authorized redirect
URIs with Google and Apple respectively before the first real sign-in —
both currently point at `127.0.0.1` for local dev only.

Register the live Stripe webhook endpoint
(`https://api.oneaboveall.org/webhooks/stripe`) in the Stripe dashboard
with **both** events enabled:

- `payment_intent.amount_capturable_updated` — every bid is an
  authorization hold (`capture_method: "manual"`); this event, fired when
  the hold is placed, is what records the bid. **Without it no bid is ever
  recorded** (bidders' cards get held, then nothing happens).
- `payment_intent.succeeded` — still needed for PaymentIntents created
  before holds existed; it also fires when the scheduler captures a winner
  at the 4 PM ET close, which is a harmless no-op.

Put the endpoint's signing secret in `STRIPE_WEBHOOK_SECRET` above — it's
different from the test-mode webhook secret already in
`apps/api/.env.example`.

### `infra/secrets/apple-private-key.p8`

The `.p8` signing key downloaded from Apple's developer portal for the
Services ID above. Never baked into any image (`.dockerignore` excludes
every `*.p8`) — mounted into the api pod at runtime as its own Kubernetes
Secret (`oneaboveall-apple-key`).

### `apps/web/.env.production`

Not a Kubernetes secret — read directly by `astro build` inside
`infra/docker/web.Dockerfile` (Astro loads `.env.production` automatically
in production mode). Gitignored, must exist **before** running
`deploy.sh` — without it, the build doesn't fail, it silently falls back to
publishing the nine mock people as the real champion and retinue (see
`index.astro`'s own comment on `degradeToMock`). `deploy.sh` refuses to run
without this file specifically to prevent that.

```bash
# Read only during the build itself (see index.astro's fetchLiveData) — the
# build runs inside the cluster (via the web-rebuilder image), so it talks
# to the api Service directly rather than going back out through the public
# domain and Traefik.
API_BASE_URL=http://oneaboveall-api

# Read by the visitor's BROWSER at runtime instead — must be the API's real
# public origin. Do NOT set this to the internal Service address above: an
# earlier deploy did exactly that and the browser tried (and failed) to
# fetch http://oneaboveall-api/auth/me directly, since that hostname only
# resolves inside the cluster.
PUBLIC_API_BASE_URL=https://api.oneaboveall.org

REQUIRE_LIVE_DATA=true

# Stripe PUBLISHABLE key — safe to expose client-side, this is not a secret.
# Still LIVE mode (pk_live_...), matching STRIPE_SECRET_KEY above.
PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
```

## Deploying

First deploy and every deploy after a code change:

```bash
bash infra/scripts/deploy.sh
```

Builds both images (timestamp-tagged, never overwritten — imports into k3s
directly, no registry), applies the namespace, (re)creates the two secrets
and the nginx ConfigMap from the files above, applies Postgres, runs the
schema push (`drizzle-kit push`, this project has no migrations directory —
see `infra/k8s/migration-job.yaml`), then rolls out `oneaboveall-api` and
`oneaboveall-web`, and applies the Ingress.

Changed only a secret (`prod.env` or the Apple key), not code:

```bash
bash infra/scripts/update-secrets.sh
kubectl rollout restart deployment/oneaboveall-api -n oneaboveall
```

## Verifying the scene rebuild pipeline

The champion's photo only refreshes when `web-rebuilder`'s `/rebuild`
endpoint is called, which only happens when `apps/api`'s scheduler installs
a new champion. To check this is actually wired up after a deploy:

```bash
kubectl logs -n oneaboveall deployment/oneaboveall-web -c web-rebuilder --tail=50
```

You should see `web rebuilder listening on :8080` from the sidecar, and
`initial build published: ...` from the initContainer's one-time run
(`kubectl logs -n oneaboveall deployment/oneaboveall-web -c initial-build`,
or `kubectl logs ... --previous` once the init container has exited). After
the next round actually closes, the api logs
(`kubectl logs -n oneaboveall deployment/oneaboveall-api`) should show no
`scheduler: failed to reach web rebuild trigger` errors around that time.

## Email (outbid / won notifications)

The api sends two transactional emails through Resend (https://resend.com),
see `apps/api/src/notifications/ResendNotifier.ts`: "You've been outbid"
when a bidder loses the top spot, and "You won the seat" when the
scheduler captures their hold at the close (asking for a photo if they
haven't uploaded one). Configured by `RESEND_API_KEY` and `EMAIL_FROM`
(default `oneaboveall <noreply@oneaboveall.org>`) in `prod.env`; links
point at `PUBLIC_APP_URL`. With no `RESEND_API_KEY` the api logs one
warning and skips every email — bidding and settlement are unaffected, and
a failed send is only ever logged.

Before setting the key: in Resend, add `oneaboveall.org` as a sending
domain and add the DNS records it gives you (SPF/DKIM TXT records) at the
same registrar as the A records above — Resend rejects mail from an
unverified domain.

## Operator runbook

Operator tooling is a small bearer-token API on the api host
(`apps/api/src/routes/admin.ts`) — no admin UI. Every call needs
`Authorization: Bearer $ADMIN_TOKEN`; with `ADMIN_TOKEN` unset in
`prod.env` the routes don't exist (404). Set up a shell first:

```bash
export API=https://api.oneaboveall.org
export ADMIN_TOKEN=...   # same value as in infra/secrets/prod.env
alias admin='curl -sS -H "Authorization: Bearer $ADMIN_TOKEN"'
```

**Streamer stats** — visits, sign-ups, distinct bidders, distinct winners
and captured revenue (cents) per `ref` code, plus totals for everyone
(attributed or not). Give each streamer their own link,
`https://oneaboveall.org/?ref=<code>` (letters, digits, `_ . -`, up to 64
chars; utm_* tags work too). The first link someone arrives through gets
the credit, permanently.

```bash
admin "$API/admin/stats" | jq
```

Treat `visits` as approximate — a traffic signal, not an audit figure.
`POST /ref-visits` is public, so the API throttles it in memory per client
IP (`apps/api/src/routes/refVisitLimiter.ts`): one counted visit per IP per
ref per 30 minutes and at most ~30 counted requests per IP per hour. Many
people behind one NAT (a campus, a mobile carrier) can count as fewer
visits; an API restart resets the throttle, so a few repeats can count
twice. Sign-ups, bidders, winners and revenue are exact.

**Current round** — the champion, the leader and the runner-up (the two
card holds still alive), each with user id, name, email, amount, whether
the hold was captured, whether a photo is on file, social link, character
request and the sponsored flag:

```bash
admin "$API/admin/round" | jq
```

**Fetching the winner's photo** (to compose the scene art). Raw photos
are no longer public — `GET /photos/:id` only serves a user their own.
After the 4 PM ET close the winner is the `leader` with `"captured": true`;
once installed (~7 PM ET) they are the `champion`.

```bash
USER_ID=$(admin "$API/admin/round" | jq -r '.leader.userId')   # or .champion.userId
admin -o "winner-$USER_ID.jpg" "$API/admin/photos/$USER_ID"
```

(The file keeps its uploaded format — check with `file winner-*.jpg`;
JPEG, PNG or WebP.)

**Marking a sponsored creator** — anyone whose seat we paid for or
arranged must be labelled; it shows as "Sponsored" next to their name on
the homepage, hover card, leaderboard and overlay:

```bash
admin -X PATCH -H 'content-type: application/json' \
  -d '{"sponsored": true}' "$API/admin/users/$USER_ID"
```

**Moderation** — clear a bad social link and/or photo, or replace an
offensive display name (any combination in one call). A cleared photo is
deleted from disk too. The public scene only changes on the next static
rebuild (next champion install) — if the bad content is already in the
composed `scene.jpg`, re-render the art too.

```bash
admin -X PATCH -H 'content-type: application/json' \
  -d '{"clearSocialUrl": true, "clearPhoto": true, "name": "Seat holder"}' \
  "$API/admin/users/$USER_ID"
```

**Stream overlay for streamers** — give them
`https://oneaboveall.org/overlay?compact=1` as an OBS **Browser Source**,
400×220 (drop `?compact=1` and use ~400×320 to include the live bid feed).
It's transparent, polls the public `/current-round` every 5 s, and its
loads never count as visits.

## Troubleshooting

- **`kubectl rollout status` times out on `oneaboveall-api`**: check
  `kubectl logs -n oneaboveall deployment/oneaboveall-api` — a missing or
  malformed env var (`STRIPE_SECRET_KEY`, `CORS_ORIGIN`,
  `GOOGLE_CLIENT_ID`, etc.) fails the process at boot with a clear error
  naming the var (see `server.ts`, `stripeClient.ts`, `authGoogle.ts`'s own
  `requireEnv` checks) rather than crash-looping silently.
- **TLS cert never issues**: `kubectl describe certificate oneaboveall-tls -n
  oneaboveall` and `kubectl get challenges -n oneaboveall` — almost always
  DNS not yet propagated, or the ClusterIssuer name mismatch from step 2
  above.
- **Photo uploads or the Apple key disappear after a redeploy**: they
  shouldn't — `api-uploads-pvc` and the `oneaboveall-apple-key` Secret both
  persist across `deploy.sh` runs. If `api-uploads-pvc` itself is deleted,
  its photos are gone; that PVC is not backed up anywhere.
