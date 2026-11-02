#!/usr/bin/env bash
# Sends a signed GitHub "issues opened" webhook to a running API, as GitHub would.
# Usage: scripts/send-test-webhook.sh [api-url] [issue-number]
set -euo pipefail

API_URL="${1:-http://localhost:8080}"
ISSUE="${2:-1}"
SECRET="${GITHUB_WEBHOOK_SECRET:-dev-secret}"

BODY=$(cat <<EOF
{"action":"opened","issue":{"number":${ISSUE},"title":"Add a contact page","body":"- Given a visitor, when they open /contact, then they see the form","labels":[{"name":"factory"}]},"repository":{"full_name":"codyalves/factory-target-app"}}
EOF
)

SIGNATURE="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')"

curl -sS -X POST "$API_URL/webhooks/github" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: issues" \
  -H "X-GitHub-Delivery: test-$(date +%s%N)" \
  -H "X-Hub-Signature-256: $SIGNATURE" \
  --data-binary "$BODY"
echo
