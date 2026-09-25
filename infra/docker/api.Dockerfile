# apps/api has no build step — it runs directly under tsx, in dev and here
# alike (see apps/api/package.json's "start" script). apps/engine is
# consumed as raw .ts through an npm workspaces symlink (its package.json
# "exports" map points straight at ./src/*.ts), not as a published package,
# so the engine source tree has to be present in the image too, not just
# copied-in dist output.
#
# Build from the REPO ROOT, not apps/api:
#   docker build -f infra/docker/api.Dockerfile -t oneabobeall-api:<tag> .
FROM node:22-alpine
WORKDIR /app

# Every workspace's package.json has to be present for `npm ci` to resolve
# the lockfile, even though only api/ and engine/ sources are copied below —
# apps/web is a workspace member too and npm ci fails on a workspace whose
# package.json it can't find.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/engine/package.json ./apps/engine/package.json
COPY apps/web/package.json ./apps/web/package.json

# Full install, devDependencies included: this same image doubles as the
# schema-push image (infra/k8s/migration-job.yaml), which needs engine's
# devDependency drizzle-kit. There is no separate "build" to strip them
# after, so there's nothing to gain from a --omit=dev stage here.
RUN npm ci

COPY apps/api ./apps/api
COPY apps/engine ./apps/engine

WORKDIR /app/apps/api
ENV NODE_ENV=production
EXPOSE 3001
CMD ["npm", "start"]
