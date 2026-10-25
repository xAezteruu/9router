#!/usr/bin/env bash
# bgSetActive.sh — flip Caddy active upstream (A=3100 / B=3101) with zero downtime
# usage: bgSetActive.sh a|b
set -euo pipefail
TARGET="${1:-}"
REPO="/home/agentuser/9router"
CADDYFILE="$REPO/deploy/Caddyfile"

case "$TARGET" in
  a) PORT=3100 ;;
  b) PORT=3101 ;;
  *) echo "usage: $0 a|b" >&2; exit 1 ;;
esac

# sanity: target must answer before we flip
if ! curl -sf -o /dev/null -m 5 "http://localhost:${PORT}/dashboard"; then
  echo "ERROR: node ${TARGET^^} (:${PORT}) is not healthy — refusing to flip" >&2
  exit 1
fi

# rewrite the Caddyfile upstream line + reload (zero-downtime: connections drain)
sudo python3 - "$PORT" <<'PYEOF'
import sys, re, pathlib
p = pathlib.Path("/etc/caddy/Caddyfile")
port = sys.argv[1]
t = p.read_text()
# only rewrite the MAIN handle block (not /deploy-webhook which points at :3102)
lines = t.split("\n")
in_hook = False
for i, ln in enumerate(lines):
    if "/deploy-webhook" in ln: in_hook = True
    elif ln.strip() == "}": in_hook = False
    if not in_hook:
        lines[i] = re.sub(r"reverse_proxy 127\.0\.0\.1:\d+", f"reverse_proxy 127.0.0.1:{port}", ln)
p.write_text("\n".join(lines))
PYEOF
sudo caddy reload --config "$CADDYFILE" >/dev/null 2>&1

# record state + verify through the proxy
echo "BG_UPSTREAM=127.0.0.1:${PORT}" > "$REPO/deploy/bg.env"
sleep 1
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 5 http://localhost:3000/dashboard)
echo "active=${TARGET^^} :${PORT} — proxy check: ${CODE}"
[ "$CODE" = "200" ] || [ "$CODE" = "307" ]
