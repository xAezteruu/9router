#!/usr/bin/env bash
# bg-health.sh — deep health check for one node (port as $1). Exit 0 only if fully healthy.
set -uo pipefail
PORT="${1:?usage: bg-health.sh <port>}"
BASE="http://100.64.1.3:${PORT}"

# 1. dashboard reachable (200 or 307 auth redirect both fine)
CODE_DASH=$(curl -s -o /dev/null -w "%{http_code}" -m 8 "${BASE}/dashboard")
[[ "$CODE_DASH" == "200" || "$CODE_DASH" == "307" ]] || { echo "dashboard:${CODE_DASH} FAIL"; exit 1; }

# 2. API surface answers (401/403 expected unauthenticated — any HTTP response means server alive & routing)
CODE_API=$(curl -s -o /dev/null -w "%{http_code}" -m 8 "${BASE}/api/announcement")
[[ "$CODE_API" != "000" ]] || { echo "api:000 FAIL"; exit 1; }

# 3. a real JS chunk must serve 200 (catches stale build manifest after racing deploys)
CHUNK=$(ls /home/agentuser/9router/.next/static/chunks/ | grep -E '^[0-9]+-.*\.js$' | head -1)
CODE_CHUNK=$(curl -s -o /dev/null -w "%{http_code}" -m 8 "${BASE}/_next/static/chunks/${CHUNK}")
[[ "$CODE_CHUNK" == "200" ]] || { echo "chunk:${CODE_CHUNK} FAIL (stale manifest?)"; exit 1; }

# 4. models endpoint through /v1 (auth-gated; 401/403 OK, connection refused NOT OK)
CODE_V1=$(curl -s -o /dev/null -w "%{http_code}" -m 8 "${BASE}/v1/models")
[[ "$CODE_V1" != "000" ]] || { echo "v1:000 FAIL"; exit 1; }

echo "OK dashboard:${CODE_DASH} api:${CODE_API} v1:${CODE_V1}"
exit 0
