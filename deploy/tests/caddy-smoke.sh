#!/bin/sh
set -eu

CADDY_IMAGE='caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648'
BUN_IMAGE='oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f'
DOMAIN='mail.example.test'
RUN_ID="nusend-caddy-smoke-$$"
NETWORK="$RUN_ID"
TRUSTED_NETWORK="$RUN_ID-trusted"
TRUSTED_CADDY_IP='173.245.63.2'
TRUSTED_CLIENT_IP='173.245.63.3'
TRUSTED_CLIENT_CONTAINER="$RUN_ID-trusted-client"
API_CONTAINER="$RUN_ID-api"
CADDY_CONTAINER="$RUN_ID-caddy"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/nusend-caddy-smoke.XXXXXX")

cleanup() {
	docker rm -f -v "$TRUSTED_CLIENT_CONTAINER" "$CADDY_CONTAINER" "$API_CONTAINER" >/dev/null 2>&1 || true
	docker network rm "$TRUSTED_NETWORK" "$NETWORK" >/dev/null 2>&1 || true
	rm -rf "$TMP_DIR"
}
trap cleanup EXIT HUP INT TERM

for command in curl docker openssl python3; do
	command -v "$command" >/dev/null 2>&1 || {
		echo "missing required command: $command" >&2
		exit 1
	}
done

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
	-subj "/CN=$DOMAIN" -addext "subjectAltName=DNS:$DOMAIN" \
	-keyout "$TMP_DIR/key.pem" -out "$TMP_DIR/cert.pem" >/dev/null 2>&1

docker network create "$NETWORK" >/dev/null
docker network create --subnet 173.245.63.0/29 "$TRUSTED_NETWORK" >/dev/null

docker run -d --name "$API_CONTAINER" --network "$NETWORK" --network-alias api \
	--read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
	--cap-drop ALL --security-opt no-new-privileges \
	--entrypoint bun "$BUN_IMAGE" -e '
Bun.serve({
  hostname: "0.0.0.0",
  port: 3000,
  async fetch(request) {
    await request.arrayBuffer();
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("{\"ok\":true,\"service\":\"nusend\"}");
    }
    return new Response([
      request.headers.get("x-forwarded-for") || "",
      request.headers.get("x-forwarded-proto") || "",
      request.headers.get("host") || ""
    ].join("|"));
  }
});
' >/dev/null

docker run -d --name "$CADDY_CONTAINER" --network "$NETWORK" --init \
	--read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
	--cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges \
	-e "NUSEND_DOMAIN=$DOMAIN" -p 127.0.0.1::443/tcp \
	-v "$PWD/deploy/caddy:/etc/caddy:ro" \
	-v "$TMP_DIR/cert.pem:/run/secrets/caddy_origin_cert:ro" \
	-v "$TMP_DIR/key.pem:/run/secrets/caddy_origin_key:ro" \
	--mount type=volume,target=/data --mount type=volume,target=/config \
	"$CADDY_IMAGE" >/dev/null
docker network connect --ip "$TRUSTED_CADDY_IP" "$TRUSTED_NETWORK" "$CADDY_CONTAINER"

PORT=$(docker port "$CADDY_CONTAINER" 443/tcp | sed -n 's/.*://p' | head -1)
[ -n "$PORT" ] || {
	echo "Caddy HTTPS port was not published" >&2
	exit 1
}
BASE_URL="https://$DOMAIN:$PORT"
CURL="curl -ksS --resolve $DOMAIN:$PORT:127.0.0.1"

assert_no_store() {
	if ! printf '%s\n' "$1" | tr -d '\r' | grep -Eiq '^Cache-Control: no-store$'; then
		echo "response omitted Cache-Control: no-store" >&2
		exit 1
	fi
}

attempt=0
until $CURL "$BASE_URL/health" >/dev/null 2>&1; do
	attempt=$((attempt + 1))
	[ "$attempt" -lt 30 ] || {
		docker logs "$CADDY_CONTAINER" >&2 || true
		exit 1
	}
	sleep 1
done

health_status=$($CURL -o "$TMP_DIR/health.body" -w '%{http_code}' "$BASE_URL/health")
[ "$health_status" = 200 ]
grep -q '"ok":true' "$TMP_DIR/health.body"
private_health_headers=$($CURL -D - -o /dev/null "$BASE_URL/health/db")
printf '%s\n' "$private_health_headers" | grep -q ' 404 '
assert_no_store "$private_health_headers"
assert_no_store "$($CURL -D - -o /dev/null "$BASE_URL/health")"

forwarded=$($CURL \
	-H 'CF-Connecting-IP: 198.51.100.77' \
	-H 'X-Forwarded-For: 203.0.113.250, 203.0.113.251' \
	"$BASE_URL/forwarding")
case "$forwarded" in
	*198.51.100.77*|*203.0.113.250*|*203.0.113.251*)
		echo "forged forwarding header reached upstream: $forwarded" >&2
		exit 1
		;;
esac
if ! printf '%s\n' "$forwarded" | grep -Eq '^[^,|]+\|https\|mail\.example\.test$'; then
	echo "forwarded Host/proto mismatch: $forwarded" >&2
	exit 1
fi

trusted_forwarded=$(docker run --rm --name "$TRUSTED_CLIENT_CONTAINER" \
	--network "$TRUSTED_NETWORK" --ip "$TRUSTED_CLIENT_IP" \
	--add-host "$DOMAIN:$TRUSTED_CADDY_IP" --entrypoint wget "$CADDY_IMAGE" \
	-qO- -T 10 --no-check-certificate \
	--header "Host: $DOMAIN" \
	--header 'CF-Connecting-IP: 198.51.100.77' \
	--header 'X-Forwarded-For: 203.0.113.250, 203.0.113.251' \
	"https://$DOMAIN/forwarding")
[ "$trusted_forwarded" = "198.51.100.77|https|$DOMAIN" ] || {
	echo "trusted CF-Connecting-IP did not take precedence: $trusted_forwarded" >&2
	exit 1
}

head -c 2097152 /dev/zero > "$TMP_DIR/boundary.body"
[ "$($CURL -o /dev/null -w '%{http_code}' -X POST --data-binary "@$TMP_DIR/boundary.body" "$BASE_URL/ordinary-upload")" = 200 ]
head -c 2097153 /dev/zero > "$TMP_DIR/oversize.body"
oversize_headers=$($CURL -D - -o /dev/null -X POST --data-binary "@$TMP_DIR/oversize.body" "$BASE_URL/ordinary-upload")
printf '%s\n' "$oversize_headers" | grep -q ' 413 '
assert_no_store "$oversize_headers"

$CURL -H 'Referer: https://referer-healthy-sentinel.example/private' \
	"$BASE_URL/ordinary-healthy-visible?ordinary-query-sentinel=secret" >/dev/null
$CURL -H 'User-Agent: unsubscribe-access-skip-marker' \
	"$BASE_URL/unsubscribe/token-healthy-sentinel?signature=healthy-signature-sentinel" >/dev/null
$CURL -H 'User-Agent: auth-access-skip-marker' \
	"$BASE_URL/api/auth/callback/google?code=healthy-oauth-sentinel" >/dev/null

case "$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$API_CONTAINER")" in
	null|'{}') ;;
	*) echo "API test container unexpectedly publishes a port" >&2; exit 1 ;;
esac
docker stop "$API_CONTAINER" >/dev/null

$CURL -H 'Referer: https://referer-error-sentinel.example/private' \
	"$BASE_URL/unsubscribe/token-error-sentinel?signature=error-signature-sentinel" >/dev/null
$CURL "$BASE_URL/api/auth/callback/google?code=error-oauth-sentinel" >/dev/null
ordinary_error_headers=$($CURL -D - -o /dev/null "$BASE_URL/ordinary-error-visible?ordinary-error-query-sentinel=secret")
printf '%s\n' "$ordinary_error_headers" | grep -q ' 502 '
assert_no_store "$ordinary_error_headers"
sleep 1

docker logs "$CADDY_CONTAINER" > "$TMP_DIR/caddy.log" 2>&1
python3 - "$TMP_DIR/caddy.log" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
lines = [line for line in path.read_text().splitlines() if line.strip()]
if not lines:
    raise SystemExit("Caddy emitted no logs")
for number, line in enumerate(lines, 1):
    try:
        json.loads(line)
    except json.JSONDecodeError as error:
        raise SystemExit(f"Caddy log line {number} is not JSON: {error}")

records = [json.loads(line) for line in lines]
text = "\n".join(lines)
for forbidden in (
    "token-healthy-sentinel",
    "healthy-signature-sentinel",
    "healthy-oauth-sentinel",
    "unsubscribe-access-skip-marker",
    "auth-access-skip-marker",
    "token-error-sentinel",
    "error-signature-sentinel",
    "error-oauth-sentinel",
    "referer-healthy-sentinel",
    "referer-error-sentinel",
    "ordinary-query-sentinel",
    "ordinary-error-query-sentinel",
):
    if forbidden in text:
        raise SystemExit(f"sensitive log value was not removed: {forbidden}")
for expected in ("ordinary-healthy-visible", "ordinary-error-visible"):
    if expected not in text:
        print(text, file=sys.stderr)
        raise SystemExit(f"ordinary route path missing from logs: {expected}")

access_records = [
    record for record in records if record.get("logger", "").startswith("http.log.access")
]
runtime_errors = [
    record for record in records if record.get("logger", "").startswith("http.log.error")
]
if not any("ordinary-healthy-visible" in record.get("request", {}).get("uri", "") for record in access_records):
    raise SystemExit("ordinary healthy route missing from access logger")
if not any("ordinary-error-visible" in record.get("request", {}).get("uri", "") for record in runtime_errors):
    raise SystemExit("ordinary 502 route missing from runtime/error logger")
if sum(record.get("request", {}).get("uri") == "[REDACTED][REDACTED]" for record in runtime_errors) < 2:
    raise SystemExit("sensitive 502 routes were not independently redacted by the runtime/error logger")
for record in runtime_errors:
    headers = record.get("request", {}).get("headers", {})
    if any(key.lower() == "referer" for key in headers):
        raise SystemExit("Referer remained in a runtime/error log record")
PY

printf '%s\n' 'Caddy smoke passed: HTTPS, limits, health routing, forwarding, and JSON log redaction.'
