#!/usr/bin/env bash
# bgSwap-panel.sh — single-alive-node deploy via Pterodactyl panel (wings API)
# Active node = whichever Caddy points at. Standby is STOPPED at panel level.
# Usage: bgSwap-panel.sh [build]   (arg unused, kept for webhook compat)
set -u

HOST_DB_SRC="/home/agentuser/.9router/db"          # canonical shared DB (mounted into both)
NODE_UUID="100.64.1.3"
WINGS="http://127.0.0.1:8085"
WINGS_TOKEN_FILE="/home/agentuser/.wings-token"    # chmod 600
PANEL="https://root.xteru.com"
PTLC_FILE="/home/agentuser/.ptlc-token"            # chmod 600
REPO="/home/agentuser/9router"
LOG="/home/agentuser/9router/.bgswap-panel.log"
STATE="/home/agentuser/9router/.bgswap-panel.state" # ACTIVE=A|B
LOCK="/tmp/9router-bgswap-panel.lock"
CADDYFILE="/etc/caddy/Caddyfile"
DRAIN_MAX=120

# Server idents (panel)
A_IDENT="ab82d038-f0a9-4b47-9810-c9b5787a5886"   # port 3100
B_IDENT="1c0ca6d6-e4bc-44a1-b417-41660d9c4121"   # port 3101
A_PORT=3100
B_PORT=3101
A_VOL="/var/lib/pterodactyl/volumes/$A_IDENT"
B_VOL="/var/lib/pterodactyl/volumes/$B_IDENT"

log(){ echo "[$(date '+%F %T')] $*" >> "$LOG"; }
W=$(cat "$WINGS_TOKEN_FILE" 2>/dev/null || true)
C=$(cat "$PTLC_FILE" 2>/dev/null || true)
[ -n "$W" ] || { log "FATAL: no wings token"; exit 1; }

# single instance
mkdir "$LOCK" 2>/dev/null || { log "another deploy running"; exit 1; }
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

power(){ # $1 ident, $2 action
  curl -s -m 30 -X POST "$WINGS/api/servers/$1/power" \
    -H "Authorization: Bearer $W" -H "Content-Type: application/json" \
    --data "{\"action\":\"$2\"}" -o /dev/null
}
wait_state(){ # $1 ident $2 up|down $3 timeout
  local i=0
  while [ $i -lt $(( $3 / 5 )) ]; do
    local st
    st=$(curl -s -m 10 "$WINGS/api/servers/$1" -H "Authorization: Bearer $W" | grep -o '"state":"[a-z]*"' | head -1 | cut -d'"' -f4)
    if [ "$2" = up ] && [ "$st" = running ]; then return 0; fi
    if [ "$2" = down ] && { [ "$st" = offline ] || [ -z "$st" ]; }; then return 0; fi
    sleep 5; i=$((i+5))
  done
  return 1
}
wait_http(){ # $1 port $2 timeout
  local i=0
  while [ $i -lt $(( $2 / 5 )) ]; do
    [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://100.64.1.3:$1/login)" = "200" ] && return 0
    sleep 5; i=$((i+5))
  done
  return 1
}
caddy_active(){ grep -q "reverse_proxy $NODE_UUID:$B_PORT" "$CADDYFILE" && echo B || echo A; }
caddy_flip(){ # $1 target port
  sudo sed -i "s|reverse_proxy $NODE_UUID:310[01]|reverse_proxy $NODE_UUID:$1|" "$CADDYFILE" \
    && sudo systemctl reload caddy
}

ACTIVE=$(cat "$STATE" 2>/dev/null || caddy_active)
# ACTIVE node keeps serving; STANDBY gets rebuilt & swapped in.
if [ "$ACTIVE" = "B" ]; then
  SA=$A_IDENT; SB=$B_IDENT; PA=$A_PORT; PB=$B_PORT; VA=$B_VOL; VB=$A_VOL
else
  SA=$B_IDENT; SB=$A_IDENT; PA=$B_PORT; PB=$A_PORT; VA=$A_VOL; VB=$B_VOL
fi
log "=== deploy start; ACTIVE=$ACTIVE (standby will be built & swapped in) ==="

# 1. pull latest code on host (repo is source of truth)
cd "$REPO" || exit 1
git pull --ff-only >> "$LOG" 2>&1 || log "WARN: git pull failed, using current tree"

# 2. build standby (its volume holds node_modules/.next); sync build from repo build? volumes are hardlinked trees:
#    rebuild inside standby volume using container image node21 (ensures correct ABI)
SB_NAME=$([ "$SA" = "$B_IDENT" ] && echo "9router-b" || echo "9router-a")
log "building standby volume $SB_NAME ..."
if ! sudo docker run --rm --user 995:995 -v "$VB":/home/container -w /home/container \
     ghcr.io/parkervcp/yolks:nodejs_24 bash -c '
       npm install --registry=https://registry.npmjs.org --prefer-offline --no-audit --no-fund >/dev/null 2>&1
       npx --yes node-gyp rebuild --directory=node_modules/better-sqlite3 >/dev/null 2>&1
       npm run build >/dev/null 2>&1
       [ -f .next/BUILD_ID ] && echo BUILD-OK
     ' | grep -q BUILD-OK; then
  log "FATAL: standby build failed"; exit 1
fi
log "standby build OK"

# 3. start standby, wait healthy (boot includes npm install — allow 6 min; wings state may flap)
power "$SA" start
if ! wait_state "$SA" up 360; then log "WARN: state not running after 360s — trying wings direct restart"; power "$SA" stop; sleep 5; power "$SA" start; wait_state "$SA" up 360 || { log "FATAL: standby failed to boot"; exit 1; }; fi
wait_http "$PB" 360 || { log "FATAL: standby /login not healthy"; power "$SA" stop; exit 1; }
# wajib: 1 chunk JS asli harus 200 (anti stale-manifest)
CHUNK=$(sudo ls "$VB"/.next/static/chunks/ 2>/dev/null | grep '\.js$' | head -1)
if [ -n "$CHUNK" ] && [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://100.64.1.3:$PB/_next/static/chunks/$CHUNK")" != "200" ]; then
  log "FATAL: chunk JS 404 — stale build"; power "$SA" stop; exit 1
fi
log "standby healthy on :$PB"

# 4. flip Caddy
caddy_flip "$PB" || { log "FATAL: caddy flip failed"; exit 1; }
sleep 2
[ "$(curl -s -m 8 -o /dev/null -w '%{http_code}' https://ai.teru.my.id/login)" = "200" ] \
  || { log "FATAL: public check failed after flip — rolling back"; caddy_flip "$PA"; exit 1; }
log "traffic flipped to :$PB"

# 5. drain old active (wait established conns to die, max DRAIN_MAX)
i=0
while [ $i -lt $DRAIN_MAX ]; do
  N=$(ss -tn state established "( dport = :$PA or sport = :$PA )" | grep -c 100.64.1.3)
  [ "$N" = "0" ] && break
  sleep 5; i=$((i+5))
done
log "drain done (${i}s)"

# 6. stop old active
power "$SB" stop
wait_state "$SB" down 60 || log "WARN: old active didn't stop cleanly"

echo "$([ "$SA" = "$B_IDENT" ] && echo B || echo A)" > "$STATE"
log "=== deploy done; NEW ACTIVE=$(cat $STATE) ==="
