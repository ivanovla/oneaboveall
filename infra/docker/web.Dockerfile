# Contains apps/web's full source + dependencies (astro is a runtime
# dependency, not a devDependency — see apps/web/package.json) plus the
# rebuild-server.mjs entrypoint (see that file's own header comment for why
# one image serves both as a one-shot initContainer and as a long-running
# sidecar). No nginx here — nginx runs from the stock nginx:alpine image in
# infra/k8s/web.yaml, serving purely from the shared volume this image
# populates.
#
# Build from the REPO ROOT:
#   docker build -f infra/docker/web.Dockerfile -t oneabobeall-web:<tag> .
#
# apps/web/.env.production must exist before building (gitignored — not
# committed). Astro's static build reads it automatically for `astro build`
# (mode "production"). See infra/README.md for its required contents.
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/engine/package.json ./apps/engine/package.json

RUN npm ci

COPY apps/web ./apps/web
COPY infra/docker/rebuild-server.mjs ./rebuild-server.mjs

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "rebuild-server.mjs"]
