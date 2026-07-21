#!/usr/bin/env bash
set -euo pipefail

# Print IDs for tagged GHCR package versions beyond the newest retained count.
# Un-tagged manifest records are intentionally left to GHCR: deleting them
# directly can damage a multi-platform image index still referenced by a tag.
#
# Usage:
#   prune-ghcr-package-versions.sh <versions.json> <retain-count>
#   prune-ghcr-package-versions.sh --self-test

fail() {
  printf 'ghcr-retention: FAIL %s\n' "$1" >&2
  exit 1
}

ids_to_delete() {
  versions_file=$1
  retain_count=$2

  jq -r --argjson retain "$retain_count" '
    if type != "array" then
      error("expected an array of GitHub package versions")
    else
      [
        .[]
        | select(.id | type == "number")
        | select((.metadata.container.tags? // []) | length > 0)
        | { id, created_at }
      ]
      | sort_by(.created_at)
      | reverse
      | .[$retain:][]?.id
    end
  ' "$versions_file"
}

if [ "${1-}" = "--self-test" ]; then
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT
  cat >"$tmp" <<'EOF'
[
  {"id": 1, "created_at": "2026-01-01T00:00:00Z", "metadata": {"container": {"tags": ["v1.0.0"]}}},
  {"id": 2, "created_at": "2026-02-01T00:00:00Z", "metadata": {"container": {"tags": ["v1.1.0"]}}},
  {"id": 3, "created_at": "2026-03-01T00:00:00Z", "metadata": {"container": {"tags": ["v1.2.0"]}}},
  {"id": 4, "created_at": "2026-04-01T00:00:00Z", "metadata": {"container": {"tags": ["v1.3.0"]}}},
  {"id": 5, "created_at": "2026-05-01T00:00:00Z", "metadata": {"container": {"tags": ["v1.4.0"]}}},
  {"id": 6, "created_at": "2026-06-01T00:00:00Z", "metadata": {"container": {"tags": []}}}
]
EOF
  actual=$(ids_to_delete "$tmp" 3)
  expected='2
1'
  [ "$actual" = "$expected" ] || fail "expected IDs 2 and 1, got: ${actual:-<none>}"
  printf 'ghcr-retention: PASS self-test\n'
  exit 0
fi

[ "${1-}" != "" ] && [ "${2-}" != "" ] || fail 'usage: <versions.json> <retain-count> | --self-test'
case "$2" in
  *[!0-9]* | '') fail 'retain count must be a positive integer' ;;
esac
[ "$2" -gt 0 ] || fail 'retain count must be a positive integer'

ids_to_delete "$1" "$2"
