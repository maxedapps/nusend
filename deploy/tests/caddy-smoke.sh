#!/bin/sh
set -eu

CADDY_IMAGE='caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648'
BUN_IMAGE='oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f'
DOMAIN='mail.example.test'
RUN_ID="nusend-caddy-smoke-$$"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/nusend-caddy-smoke.XXXXXX")

cleanup() {
	for mode in direct cloudflare; do
		docker rm -f -v \
			"$RUN_ID-$mode-trusted-client" \
			"$RUN_ID-$mode-caddy" \
			"$RUN_ID-$mode-api" >/dev/null 2>&1 || true
		docker network rm \
			"$RUN_ID-$mode-trusted" \
			"$RUN_ID-$mode" >/dev/null 2>&1 || true
	done
	rm -rf "$TMP_DIR"
}
trap cleanup EXIT HUP INT TERM

fail() {
	printf '%s\n' "[$1] $2" >&2
	exit 1
}

for command in cmp curl diff docker grep openssl python3; do
	command -v "$command" >/dev/null 2>&1 || {
		echo "missing required command: $command" >&2
		exit 1
	}
done

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
	-subj "/CN=$DOMAIN" -addext "subjectAltName=DNS:$DOMAIN" \
	-keyout "$TMP_DIR/key.pem" -out "$TMP_DIR/cert.pem" >/dev/null 2>&1

assert_no_store() {
	mode=$1
	headers=$2
	if ! printf '%s\n' "$headers" | tr -d '\r' | grep -Eiq '^Cache-Control: no-store$'; then
		fail "$mode" 'response omitted Cache-Control: no-store'
	fi
}

prepare_config() {
	mode=$1
	production_dir="$PWD/deploy/caddy/$mode"
	mode_dir="$TMP_DIR/$mode"
	test_dir="$mode_dir/config"
	mkdir -p "$test_dir" "$mode_dir/production-data" "$mode_dir/production-config" \
		"$mode_dir/data" "$mode_dir/runtime-config"
	printf '%s\n' "[$mode] validating untouched production config and TLS-only test adaptation."

	fmt_diff=$(docker run --rm --entrypoint caddy \
		-v "$production_dir:/etc/caddy:ro" \
		"$CADDY_IMAGE" fmt --diff /etc/caddy/Caddyfile)
	if printf '%s\n' "$fmt_diff" | grep -Eq '^[+-] '; then
		printf '%s\n' "$fmt_diff" >&2
		fail "$mode" 'production Caddyfile is not formatted'
	fi

	# Validate the untouched automatic-HTTPS production file before adapting TLS for offline smoke.
	docker run --rm --entrypoint caddy -e "NUSEND_DOMAIN=$DOMAIN" \
		-v "$production_dir:/etc/caddy:ro" \
		-v "$mode_dir/production-data:/data" \
		-v "$mode_dir/production-config:/config" \
		"$CADDY_IMAGE" adapt --validate --config /etc/caddy/Caddyfile --adapter caddyfile \
		>/dev/null
	docker run --rm --entrypoint caddy -e "NUSEND_DOMAIN=$DOMAIN" \
		-v "$production_dir:/etc/caddy:ro" \
		-v "$mode_dir/production-data:/data" \
		-v "$mode_dir/production-config:/config" \
		"$CADDY_IMAGE" validate --config /etc/caddy/Caddyfile --adapter caddyfile \
		>/dev/null

	cp "$production_dir/Caddyfile" "$test_dir/Caddyfile"
	cp "$TMP_DIR/cert.pem" "$test_dir/cert.pem"
	cp "$TMP_DIR/key.pem" "$test_dir/key.pem"
	python3 - "$test_dir/Caddyfile" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
site = "{$NUSEND_DOMAIN} {\n"
if text.count(site) != 1:
    raise SystemExit("site block marker was not found exactly once")
path.write_text(text.replace(site, site + "\ttls /etc/caddy/cert.pem /etc/caddy/key.pem\n", 1))
PY

	# Retain the diff and prove the one test TLS line is the only production-file change.
	diff -u "$production_dir/Caddyfile" "$test_dir/Caddyfile" > "$mode_dir/test-tls.diff" || true
	[ "$(grep -Fxc '	tls /etc/caddy/cert.pem /etc/caddy/key.pem' "$test_dir/Caddyfile")" -eq 1 ] || \
		fail "$mode" 'test TLS directive was not injected exactly once'
	grep -Fv '	tls /etc/caddy/cert.pem /etc/caddy/key.pem' "$test_dir/Caddyfile" \
		> "$mode_dir/Caddyfile.without-test-tls"
	cmp -s "$production_dir/Caddyfile" "$mode_dir/Caddyfile.without-test-tls" || {
		cat "$mode_dir/test-tls.diff" >&2
		fail "$mode" 'offline smoke changed more than the TLS directive'
	}

	docker run --rm --entrypoint caddy -e "NUSEND_DOMAIN=$DOMAIN" \
		-v "$test_dir:/etc/caddy:ro" \
		-v "$mode_dir/data:/data" \
		-v "$mode_dir/runtime-config:/config" \
		"$CADDY_IMAGE" adapt --validate --config /etc/caddy/Caddyfile --adapter caddyfile \
		>/dev/null
}

run_mode() {
	mode=$1
	case "$mode" in
		direct) trusted_subnet='173.245.62.0/29' ;;
		cloudflare) trusted_subnet='173.245.63.0/29' ;;
		*) fail "$mode" 'unknown smoke mode' ;;
	esac
	trusted_caddy_ip=$(printf '%s' "$trusted_subnet" | sed 's/0\/29$/2/')
	trusted_client_ip=$(printf '%s' "$trusted_subnet" | sed 's/0\/29$/3/')
	network="$RUN_ID-$mode"
	trusted_network="$RUN_ID-$mode-trusted"
	trusted_client_container="$RUN_ID-$mode-trusted-client"
	api_container="$RUN_ID-$mode-api"
	caddy_container="$RUN_ID-$mode-caddy"
	mode_dir="$TMP_DIR/$mode"
	test_dir="$mode_dir/config"

	prepare_config "$mode"
	printf '%s\n' "[$mode] running shared and mode-specific boundary assertions."
	docker network create "$network" >/dev/null
	docker network create --subnet "$trusted_subnet" "$trusted_network" >/dev/null

	docker run -d --name "$api_container" --network "$network" --network-alias api \
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

	docker run -d --name "$caddy_container" --network "$network" --init \
		--read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
		--cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges \
		-e "NUSEND_DOMAIN=$DOMAIN" -p 127.0.0.1::443/tcp \
		-v "$test_dir:/etc/caddy:ro" \
		-v "$mode_dir/data:/data" \
		-v "$mode_dir/runtime-config:/config" \
		"$CADDY_IMAGE" >/dev/null
	docker network connect --ip "$trusted_caddy_ip" "$trusted_network" "$caddy_container"

	port=$(docker port "$caddy_container" 443/tcp | sed -n 's/.*://p' | head -1)
	[ -n "$port" ] || fail "$mode" 'Caddy HTTPS port was not published'
	base_url="https://$DOMAIN:$port"

	attempt=0
	until curl -ksS --resolve "$DOMAIN:$port:127.0.0.1" "$base_url/health" >/dev/null 2>&1; do
		attempt=$((attempt + 1))
		[ "$attempt" -lt 30 ] || {
			docker logs "$caddy_container" >&2 || true
			fail "$mode" 'Caddy did not become ready'
		}
		sleep 1
	done

	health_status=$(curl -ksS --resolve "$DOMAIN:$port:127.0.0.1" \
		-o "$mode_dir/health.body" -w '%{http_code}' "$base_url/health")
	[ "$health_status" = 200 ] || fail "$mode" "public health returned $health_status"
	grep -q '"ok":true' "$mode_dir/health.body" || fail "$mode" 'public health body mismatch'
	private_health_headers=$(curl -ksS --resolve "$DOMAIN:$port:127.0.0.1" \
		-D - -o /dev/null "$base_url/health/db")
	printf '%s\n' "$private_health_headers" | grep -q ' 404 ' || fail "$mode" 'private health was exposed'
	assert_no_store "$mode" "$private_health_headers"
	assert_no_store "$mode" "$(curl -ksS --resolve "$DOMAIN:$port:127.0.0.1" -D - -o /dev/null "$base_url/health")"

	forwarded=$(curl -ksS --resolve "$DOMAIN:$port:127.0.0.1" \
		-H 'CF-Connecting-IP: 198.51.100.77' \
		-H 'X-Forwarded-For: 203.0.113.250, 203.0.113.251' \
		"$base_url/forwarding")
	case "$forwarded" in
		*198.51.100.77*|*203.0.113.250*|*203.0.113.251*)
			fail "$mode" "forged forwarding header reached upstream: $forwarded" ;;
	esac
	printf '%s\n' "$forwarded" | grep -Eq '^[^,|]+\|https\|mail\.example\.test$' || \
		fail "$mode" "forwarded Host/proto mismatch: $forwarded"

	trusted_forwarded=$(docker run --rm --name "$trusted_client_container" \
		--network "$trusted_network" --ip "$trusted_client_ip" \
		--add-host "$DOMAIN:$trusted_caddy_ip" --entrypoint wget "$CADDY_IMAGE" \
		-qO- -T 10 --no-check-certificate \
		--header "Host: $DOMAIN" \
		--header 'CF-Connecting-IP: 198.51.100.77' \
		--header 'X-Forwarded-For: 203.0.113.250, 203.0.113.251' \
		"https://$DOMAIN/forwarding")
	case "$mode" in
		direct) expected_trusted="$trusted_client_ip|https|$DOMAIN" ;;
		cloudflare) expected_trusted="198.51.100.77|https|$DOMAIN" ;;
	esac
	[ "$trusted_forwarded" = "$expected_trusted" ] || \
		fail "$mode" "trusted-range forwarding mismatch: $trusted_forwarded"

	head -c 2097152 /dev/zero > "$mode_dir/boundary.body"
	boundary_status=$(curl -ksS --resolve "$DOMAIN:$port:127.0.0.1" \
		-o /dev/null -w '%{http_code}' -X POST --data-binary "@$mode_dir/boundary.body" \
		"$base_url/ordinary-upload")
	[ "$boundary_status" = 200 ] || fail "$mode" "2 MiB body returned $boundary_status"
	head -c 2097153 /dev/zero > "$mode_dir/oversize.body"
	oversize_headers=$(curl -ksS --resolve "$DOMAIN:$port:127.0.0.1" \
		-D - -o /dev/null -X POST --data-binary "@$mode_dir/oversize.body" \
		"$base_url/ordinary-upload")
	printf '%s\n' "$oversize_headers" | grep -q ' 413 ' || fail "$mode" 'oversize body was accepted'
	assert_no_store "$mode" "$oversize_headers"

	curl -ksS --resolve "$DOMAIN:$port:127.0.0.1" \
		-H 'Referer: https://referer-healthy-sentinel.example/private' \
		"$base_url/ordinary-healthy-visible?ordinary-query-sentinel=secret" >/dev/null
	curl -ksS --resolve "$DOMAIN:$port:127.0.0.1" \
		-H 'User-Agent: unsubscribe-access-skip-marker' \
		"$base_url/unsubscribe/token-healthy-sentinel?signature=healthy-signature-sentinel" >/dev/null
	curl -ksS --resolve "$DOMAIN:$port:127.0.0.1" \
		-H 'User-Agent: auth-access-skip-marker' \
		"$base_url/api/auth/callback/google?code=healthy-oauth-sentinel" >/dev/null

	case "$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$api_container")" in
		null|'{}') ;;
		*) fail "$mode" 'API test container unexpectedly publishes a port' ;;
	esac
	docker stop "$api_container" >/dev/null

	curl -ksS --resolve "$DOMAIN:$port:127.0.0.1" \
		-H 'Referer: https://referer-error-sentinel.example/private' \
		"$base_url/unsubscribe/token-error-sentinel?signature=error-signature-sentinel" >/dev/null
	curl -ksS --resolve "$DOMAIN:$port:127.0.0.1" \
		"$base_url/api/auth/callback/google?code=error-oauth-sentinel" >/dev/null
	ordinary_error_headers=$(curl -ksS --resolve "$DOMAIN:$port:127.0.0.1" \
		-D - -o /dev/null "$base_url/ordinary-error-visible?ordinary-error-query-sentinel=secret")
	printf '%s\n' "$ordinary_error_headers" | grep -q ' 502 ' || fail "$mode" 'upstream failure did not return 502'
	assert_no_store "$mode" "$ordinary_error_headers"
	sleep 1

	docker logs "$caddy_container" > "$mode_dir/caddy.log" 2>&1
	python3 - "$mode" "$mode_dir/caddy.log" <<'PY'
import json
import pathlib
import sys

mode = sys.argv[1]
path = pathlib.Path(sys.argv[2])
lines = [line for line in path.read_text().splitlines() if line.strip()]
if not lines:
    raise SystemExit(f"[{mode}] Caddy emitted no logs")
for number, line in enumerate(lines, 1):
    try:
        json.loads(line)
    except json.JSONDecodeError as error:
        raise SystemExit(f"[{mode}] Caddy log line {number} is not JSON: {error}")

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
        raise SystemExit(f"[{mode}] sensitive log value was not removed: {forbidden}")
for expected in ("ordinary-healthy-visible", "ordinary-error-visible"):
    if expected not in text:
        print(text, file=sys.stderr)
        raise SystemExit(f"[{mode}] ordinary route path missing from logs: {expected}")

access_records = [
    record for record in records if record.get("logger", "").startswith("http.log.access")
]
runtime_errors = [
    record for record in records if record.get("logger", "").startswith("http.log.error")
]
if not any("ordinary-healthy-visible" in record.get("request", {}).get("uri", "") for record in access_records):
    raise SystemExit(f"[{mode}] ordinary healthy route missing from access logger")
if not any("ordinary-error-visible" in record.get("request", {}).get("uri", "") for record in runtime_errors):
    raise SystemExit(f"[{mode}] ordinary 502 route missing from runtime/error logger")
if sum(record.get("request", {}).get("uri") == "[REDACTED][REDACTED]" for record in runtime_errors) < 2:
    raise SystemExit(f"[{mode}] sensitive 502 routes were not independently redacted")
for record in runtime_errors:
    headers = record.get("request", {}).get("headers", {})
    if any(key.lower() == "referer" for key in headers):
        raise SystemExit(f"[{mode}] Referer remained in a runtime/error log record")
PY

	docker rm -f -v "$caddy_container" "$api_container" >/dev/null 2>&1 || true
	docker network rm "$trusted_network" "$network" >/dev/null
	printf '%s\n' "[$mode] Caddy smoke passed."
}

run_mode direct
run_mode cloudflare
printf '%s\n' 'Caddy smoke passed for direct and Cloudflare modes: production adaptation, HTTPS, limits, health, forwarding, and log redaction.'
