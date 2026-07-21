#!/bin/sh
set -eu

# Pure check: release tag, Compose app image tag, and Compose backup image tag must match.
# Usage:
#   sh deploy/tests/release-tag-align.sh <tag> <compose-file>
#   sh deploy/tests/release-tag-align.sh --self-test

fail() {
  printf 'release-tag-align: FAIL %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'release-tag-align: PASS %s\n' "$1"
}

extract_tags() {
  compose_file=$1
  app_tag=$(grep -E 'ghcr\.io/maxedapps/nusend:v' "$compose_file" | head -n1 | sed -E 's/.*nusend:(v[^[:space:]]+).*/\1/')
  backup_tag=$(grep -E 'ghcr\.io/maxedapps/nusend-backup:v' "$compose_file" | head -n1 | sed -E 's/.*nusend-backup:(v[^[:space:]]+).*/\1/')
}

aligned() {
  tag=$1
  compose_file=$2
  extract_tags "$compose_file"
  [ -n "$app_tag" ] || return 1
  [ -n "$backup_tag" ] || return 1
  [ "$app_tag" = "$tag" ] || return 1
  [ "$backup_tag" = "$tag" ] || return 1
  return 0
}

if [ "${1-}" = "--self-test" ]; then
  tmp=$(mktemp)
  cat >"$tmp" <<'EOF'
x-app-image: &app-image ghcr.io/maxedapps/nusend:v1.2.3
x-backup-image: &backup-image ghcr.io/maxedapps/nusend-backup:v1.2.3
EOF
  aligned v1.2.3 "$tmp" || fail 'matching fixture should pass'
  if aligned v9.9.9 "$tmp"; then
    rm -f "$tmp"
    fail 'version mismatch fixture unexpectedly passed'
  fi
  cat >"$tmp" <<'EOF'
x-app-image: &app-image ghcr.io/maxedapps/nusend:v1.2.3
x-backup-image: &backup-image ghcr.io/maxedapps/nusend-backup:v1.2.4
EOF
  if aligned v1.2.3 "$tmp"; then
    rm -f "$tmp"
    fail 'backup mismatch fixture unexpectedly passed'
  fi
  rm -f "$tmp"
  pass self-test
  exit 0
fi

[ "${1-}" != "" ] && [ "${2-}" != "" ] || fail 'usage: release-tag-align.sh <tag> <compose-file> | --self-test'
aligned "$1" "$2" || fail "tag $1 does not match compose anchors in $2"
pass "$1"
