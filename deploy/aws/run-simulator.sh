#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

SUCCESS_MODE="end-to-end"
case "${1:-}" in
  "") ;;
  --success-send-acceptance) SUCCESS_MODE="send-acceptance" ;;
  --help)
    cat <<'EOF'
Usage: deploy/aws/run-simulator.sh [--success-send-acceptance]

Runs success, bounce, and complaint SES mailbox-simulator scenarios inside the
deployed API container. Success defaults to end-to-end and therefore requires
DELIVERY events. Use --success-send-acceptance only when DELIVERY was explicitly
disabled. Bounce and complaint always run end-to-end. Requires Docker, not Node.
EOF
    exit 0
    ;;
  *) fail "Unknown argument: $1" ;;
esac
[[ $# -le 1 ]] || fail "Only one mode may be supplied."
command -v docker >/dev/null 2>&1 || fail "Missing required command: docker"

answer=""
read -r -p "This sends live SES mailbox-simulator messages and may be rate-limited or billed. Type RUN-SES-SIMULATOR to continue: " answer
[[ "$answer" == "RUN-SES-SIMULATOR" ]] || fail "Confirmation cancelled."

cd "$REPO_ROOT"
docker compose ps api
docker compose exec -T api bun apps/service/src/ses/simulator-main.ts \
  success --purpose transactional --mode "$SUCCESS_MODE"
docker compose exec -T api bun apps/service/src/ses/simulator-main.ts \
  bounce --purpose transactional --mode end-to-end
docker compose exec -T api bun apps/service/src/ses/simulator-main.ts \
  complaint --purpose transactional --mode end-to-end

printf '\nSimulator scenarios completed. Run deploy/aws/validate-nusend.sh in final mode to verify feedback and suppressions.\n'
