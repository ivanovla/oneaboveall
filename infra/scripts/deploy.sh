#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
K8S_DIR="$PROJECT_ROOT/infra/k8s"
DOCKER_DIR="$PROJECT_ROOT/infra/docker"
SECRETS_DIR="$PROJECT_ROOT/infra/secrets"
NAMESPACE="oneaboveall"
TIMESTAMP=$(date +%Y%m%d%H%M%S)

echo "Configuring kubectl..."
export KUBECONFIG="$SECRETS_DIR/kubeconfig"
kubectl cluster-info || { echo "Cannot connect to cluster"; exit 1; }

if [ ! -f "$SECRETS_DIR/prod.env" ]; then
  echo "Missing $SECRETS_DIR/prod.env — see infra/README.md for its required contents."
  exit 1
fi
if [ ! -f "$SECRETS_DIR/apple-private-key.p8" ]; then
  echo "Missing $SECRETS_DIR/apple-private-key.p8 — see infra/README.md."
  exit 1
fi
if [ ! -f "$PROJECT_ROOT/apps/web/.env.production" ]; then
  echo "Missing apps/web/.env.production — the static build reads it at build"
  echo "time. Without it, astro build silently publishes mock data instead of"
  echo "failing. See infra/README.md."
  exit 1
fi

# Prune images from previous deploys. Every image here is tagged with a
# unique TIMESTAMP and never overwritten, so without this the node's disk
# fills up over time (ephemeral-storage) and kubelet starts evicting pods
# mid-rollout — the same failure mode job-link-boil's deploy.sh guards
# against (see its own comment).
echo "Pruning images from previous deploys..."
sudo k3s crictl rmi --prune || true
docker image prune -af || true
docker builder prune -af || true

echo "Building api image..."
docker build -t oneaboveall-api:${TIMESTAMP} -f "$DOCKER_DIR/api.Dockerfile" "$PROJECT_ROOT"
echo "Importing api image into k3s..."
docker save oneaboveall-api:${TIMESTAMP} | sudo k3s ctr images import -

echo "Building web image..."
docker build -t oneaboveall-web:${TIMESTAMP} -f "$DOCKER_DIR/web.Dockerfile" "$PROJECT_ROOT"
echo "Importing web image into k3s..."
docker save oneaboveall-web:${TIMESTAMP} | sudo k3s ctr images import -

echo "Applying namespace..."
kubectl apply -f "$K8S_DIR/namespace.yaml"

# .env files are read directly as KEY=VALUE pairs by --from-env-file, not
# source'd as shell — sourcing would mis-parse any value containing a
# space, $, or parenthesis (same reasoning as job-link-boil's deploy.sh).
echo "Creating/updating secrets..."
kubectl create secret generic oneaboveall-secrets \
  --namespace="$NAMESPACE" \
  --from-env-file="$SECRETS_DIR/prod.env" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic oneaboveall-apple-key \
  --namespace="$NAMESPACE" \
  --from-file=apple-private-key.p8="$SECRETS_DIR/apple-private-key.p8" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Creating/updating nginx config..."
kubectl create configmap oneaboveall-nginx-conf \
  --namespace="$NAMESPACE" \
  --from-file=default.conf="$DOCKER_DIR/nginx.conf" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Applying Postgres..."
kubectl apply -f "$K8S_DIR/postgres.yaml"
echo "Waiting for Postgres..."
kubectl rollout status deployment/postgres -n "$NAMESPACE" --timeout=120s

echo "Running schema push..."
export IMAGE_TAG="${TIMESTAMP}"
envsubst '${IMAGE_TAG}' < "$K8S_DIR/migration-job.yaml" | kubectl apply -f -
kubectl wait --for=condition=complete --timeout=120s "job/oneaboveall-migrate-${TIMESTAMP}" -n "$NAMESPACE"

echo "Deploying api and web..."
envsubst '${IMAGE_TAG}' < "$K8S_DIR/api.yaml" | kubectl apply -f -
envsubst '${IMAGE_TAG}' < "$K8S_DIR/web.yaml" | kubectl apply -f -
kubectl apply -f "$K8S_DIR/ingress.yaml"

echo "Checking rollout status..."
kubectl rollout status deployment/oneaboveall-api -n "$NAMESPACE" --timeout=300s
kubectl rollout status deployment/oneaboveall-web -n "$NAMESPACE" --timeout=300s

echo "Deploy complete (image tag: ${TIMESTAMP})"
