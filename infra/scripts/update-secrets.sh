#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SECRETS_DIR="$PROJECT_ROOT/infra/secrets"
NAMESPACE="oneabobeall"

export KUBECONFIG="$SECRETS_DIR/kubeconfig"

echo "Updating secrets from infra/secrets/prod.env and apple-private-key.p8..."

kubectl create secret generic oneabobeall-secrets \
  --namespace="$NAMESPACE" \
  --from-env-file="$SECRETS_DIR/prod.env" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic oneabobeall-apple-key \
  --namespace="$NAMESPACE" \
  --from-file=apple-private-key.p8="$SECRETS_DIR/apple-private-key.p8" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secrets updated. Restart the api deployment to pick up new values:"
echo "  kubectl rollout restart deployment/oneabobeall-api -n $NAMESPACE"
