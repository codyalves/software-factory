#!/usr/bin/env bash
# Operator switch for a running factory: pause it, resume it, set its daily budget.
#
#   scripts/factory.sh status
#   scripts/factory.sh resume
#   scripts/factory.sh pause "done for the day"
#   scripts/factory.sh budget 2.50 [America/New_York]
#
# Needs ADMIN_TOKEN (from .env). FACTORY_URL defaults to http://localhost:8080.
# FACTORY_ACTOR (default: your git user name, else $USER) is recorded in the audit log.
set -euo pipefail

FACTORY_URL="${FACTORY_URL:-http://localhost:8080}"
if [[ -z "${ADMIN_TOKEN:-}" && -f .env ]]; then
  ADMIN_TOKEN="$(grep -E '^ADMIN_TOKEN=' .env | cut -d= -f2- || true)"
fi
: "${ADMIN_TOKEN:?set ADMIN_TOKEN (or put it in .env)}"
ACTOR="${FACTORY_ACTOR:-$(git config user.name 2>/dev/null || echo "${USER:-operator}")}"

call() {
  curl -sS --fail-with-body -X "$1" "$FACTORY_URL/admin/$2" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    ${3:+-H "Content-Type: application/json" --data "$3"}
  echo
}

# JSON-encodes one string argument without needing jq.
json_string() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }

case "${1:-status}" in
  status) call GET status ;;
  resume) call POST resume "{\"actor\":$(json_string "$ACTOR")}" ;;
  pause)
    reason="${2:-paused from the command line}"
    call POST pause "{\"actor\":$(json_string "$ACTOR"),\"reason\":$(json_string "$reason")}"
    ;;
  budget)
    : "${2:?usage: scripts/factory.sh budget <usd-per-day> [time-zone]}"
    zone="${3:+,\"timeZone\":$(json_string "$3")}"
    call PUT budget "{\"actor\":$(json_string "$ACTOR"),\"dailyBudgetUsd\":$2${zone}}"
    ;;
  *)
    sed -n '2,10p' "$0"
    exit 2
    ;;
esac
