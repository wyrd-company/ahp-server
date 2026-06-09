#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
NATS_CONTAINER=${NATS_CONTAINER:-ahp-server-nats-validation}
NATS_IMAGE=${NATS_IMAGE:-nats:2.10-alpine}
CODEX_E2E_MODEL=${CODEX_E2E_MODEL:-gpt-5.5}
CODEX_LIVE_TURN_PROMPT=${CODEX_LIVE_TURN_PROMPT:-Reply with exactly: pong}

started_nats=0
started_cas=0
cas_pid=""

cleanup() {
  if [[ "$started_cas" == "1" && -n "$cas_pid" ]]; then
    kill "$cas_pid" >/dev/null 2>&1 || true
    wait "$cas_pid" >/dev/null 2>&1 || true
  fi
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

if [[ -z "${CODEX_APP_SERVER_URL:-}" && -z "${CODEX_APP_SERVER_SOCKET:-}" ]]; then
  socket_dir=${CODEX_APP_SERVER_SOCKET_DIR:-/tmp/ahp-cas}
  rm -rf "$socket_dir"
  mkdir -p "$socket_dir"
  chmod 700 "$socket_dir"
  export CODEX_APP_SERVER_SOCKET="$socket_dir/app-server-control.sock"
  codex app-server --listen "unix://$CODEX_APP_SERVER_SOCKET" >/tmp/ahp-server-cas-live.log 2>&1 &
  cas_pid=$!
  started_cas=1
  for _ in $(seq 1 100); do
    if [[ -S "$CODEX_APP_SERVER_SOCKET" ]]; then
      break
    fi
    if ! kill -0 "$cas_pid" >/dev/null 2>&1; then
      cat /tmp/ahp-server-cas-live.log >&2
      exit 1
    fi
    sleep 0.1
  done
  if [[ ! -S "$CODEX_APP_SERVER_SOCKET" ]]; then
    echo "Codex App Server socket did not appear at $CODEX_APP_SERVER_SOCKET" >&2
    cat /tmp/ahp-server-cas-live.log >&2
    exit 1
  fi
fi

export CODEX_E2E_MODEL
export CODEX_LIVE_TURN_PROMPT

cd "$ROOT_DIR"
node --test --import tsx test/live-vertical-slice.test.ts
