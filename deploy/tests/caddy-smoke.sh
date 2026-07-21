#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
PROJECT=nusend-caddy-smoke-$$
NETWORK=${PROJECT}_net
WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/nusend-caddy-smoke.XXXXXX")
API_CID=
CADDY_CID=
MODE=

cleanup() {
  status=$?
  if [ -n "$CADDY_CID" ]; then docker rm -f "$CADDY_CID" >/dev/null 2>&1 || true; fi
  if [ -n "$API_CID" ]; then docker rm -f "$API_CID" >/dev/null 2>&1 || true; fi
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf -- "$WORKDIR"
  exit "$status"
}
trap cleanup EXIT INT TERM

pass() {
  printf 'PASS %s\n' "$1"
}

fail() {
  printf 'FAIL %s: %s\n' "${MODE:-setup}" "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "missing command: docker"

docker network create "$NETWORK" >/dev/null

cat >"$WORKDIR/upstream.js" <<'EOF'
Bun.serve({
  port: 3000,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok", { status: 200 });
    if (url.pathname === "/health/db") return new Response("db-ok", { status: 200 });
    if (url.pathname === "/echo") {
      return Response.json({
        host: req.headers.get("host"),
        xff: req.headers.get("x-forwarded-for"),
        xfp: req.headers.get("x-forwarded-proto"),
      });
    }
    if (url.pathname.startsWith("/api/auth/")) return new Response("auth", { status: 200 });
    return new Response("missing", { status: 404 });
  },
});
EOF

API_CID=$(docker run -d --rm \
  --name "${PROJECT}_api" \
  --network "$NETWORK" \
  --network-alias api \
  -v "$WORKDIR/upstream.js:/upstream.js:ro" \
  oven/bun:1.3.14-debian \
  bun /upstream.js)

# Wait for upstream
for _ in $(seq 1 30); do
  if docker exec "$API_CID" bun -e 'const r=await fetch("http://127.0.0.1:3000/health"); if(!r.ok) process.exit(1)' \
    >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

run_mode() {
  MODE=$1
  config_path="/etc/nusend-caddy/${MODE}/Caddyfile"
  data_dir="$WORKDIR/${MODE}-data"
  config_dir="$WORKDIR/${MODE}-config"
  mode_dir="$WORKDIR/${MODE}-tree"
  mkdir -m 0700 "$data_dir" "$config_dir"
  mkdir -p "$mode_dir/direct" "$mode_dir/cloudflare"
  # Offline TLS adaptation: bind the site on :80 while preserving each mode's trust policy.
  sed 's/{$NUSEND_DOMAIN}/:80/' "$ROOT/deploy/caddy/direct/Caddyfile" >"$mode_dir/direct/Caddyfile"
  sed 's/{$NUSEND_DOMAIN}/:80/' "$ROOT/deploy/caddy/cloudflare/Caddyfile" >"$mode_dir/cloudflare/Caddyfile"

  docker run --rm \
    -e NUSEND_DOMAIN=mail.example.com \
    -v "$ROOT/deploy/caddy:/etc/nusend-caddy:ro" \
    caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 \
    caddy validate --config "/etc/nusend-caddy/${MODE}/Caddyfile" --adapter caddyfile >/dev/null \
    || fail "production caddy validate failed for $MODE"

  CADDY_CID=$(docker run -d --rm \
    --name "${PROJECT}_caddy_${MODE}" \
    --network "$NETWORK" \
    -e NUSEND_DOMAIN=mail.example.com \
    -v "$mode_dir:/etc/nusend-caddy:ro" \
    -v "$data_dir:/data" \
    -v "$config_dir:/config" \
    caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 \
    caddy run --config "$config_path" --adapter caddyfile)

  ready=0
  for _ in $(seq 1 40); do
    if docker exec "$CADDY_CID" wget -q -O - http://127.0.0.1/health >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.25
  done
  [ "$ready" -eq 1 ] || fail "caddy did not become ready"

  health=$(docker exec "$CADDY_CID" wget -q -O - http://127.0.0.1/health) || fail "public health failed"
  [ "$health" = "ok" ] || fail "unexpected health body: $health"

  set +e
  private_out=$(docker exec "$CADDY_CID" wget -q -S -O - http://127.0.0.1/health/db 2>&1)
  set -e
  printf '%s' "$private_out" | grep -E 'HTTP/1\.1 404|HTTP/2 404' >/dev/null \
    || fail "private health not hidden: $private_out"

  echo_json=$(docker exec "$CADDY_CID" wget -q -O - \
    --header='X-Forwarded-For: 203.0.113.9' \
    --header='CF-Connecting-IP: 198.51.100.20' \
    --header='X-Forwarded-Proto: http' \
    --header='Host: forged.example' \
    http://127.0.0.1/echo) || fail "echo failed"

  printf '%s' "$echo_json" | grep -F '"xfp":"https"' >/dev/null \
    || fail "did not force https proto: $echo_json"

  if [ "$MODE" = "direct" ]; then
    printf '%s' "$echo_json" | grep -F '203.0.113.9' >/dev/null \
      && fail "direct mode trusted forged XFF: $echo_json"
    printf '%s' "$echo_json" | grep -F '198.51.100.20' >/dev/null \
      && fail "direct mode trusted CF-Connecting-IP: $echo_json"
  else
    # From an untrusted local peer, Cloudflare client-IP headers must not win.
    printf '%s' "$echo_json" | grep -F '198.51.100.20' >/dev/null \
      && fail "cloudflare mode trusted untrusted CF-Connecting-IP: $echo_json"
    printf '%s' "$echo_json" | grep -F '203.0.113.9' >/dev/null \
      && fail "cloudflare mode trusted untrusted XFF: $echo_json"
  fi

  auth_body=$(docker exec "$CADDY_CID" wget -q -O - http://127.0.0.1/api/auth/session) \
    || fail "auth route failed"
  [ "$auth_body" = "auth" ] || fail "unexpected auth body"

  grep -F '[REDACTED]' "$ROOT/deploy/caddy/${MODE}/Caddyfile" >/dev/null \
    || fail "missing log redaction filter"

  docker rm -f "$CADDY_CID" >/dev/null
  CADDY_CID=
  pass "$MODE"
}

run_mode direct
run_mode cloudflare

if docker run --rm \
  -v "$ROOT/deploy/caddy:/etc/nusend-caddy:ro" \
  caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 \
  caddy validate --config /etc/nusend-caddy/not-a-mode/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  fail "invalid ingress mode unexpectedly validated"
fi
pass "invalid-mode-rejected"

printf 'PASS caddy-smoke\n'
