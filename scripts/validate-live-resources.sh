#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source "$ROOT_DIR/scripts/load-dotenv.sh"
load_dotenv "$ROOT_DIR/.env"

NATS_CONTAINER=${NATS_CONTAINER:-ahp-server-resource-nats-validation}
NATS_IMAGE=${NATS_IMAGE:-nats:2.10-alpine}

started_nats=0

cleanup() {
  if [[ "$started_nats" == "1" ]]; then
    docker rm -f "$NATS_CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -z "${NATS_URL:-}" ]]; then
  docker rm -f "$NATS_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --rm --name "$NATS_CONTAINER" "$NATS_IMAGE" -js >/dev/null
  started_nats=1
  NATS_IP=$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$NATS_CONTAINER")
  export NATS_URL="nats://$NATS_IP:4222"
fi

cd "$ROOT_DIR"
npm run build
node --test --import tsx test/resource-process-live.test.ts
