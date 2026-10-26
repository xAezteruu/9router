#!/usr/bin/env bash
# bgSwap-panel.sh v5 - single-alive-node deploy via Pterodactyl panel (wings API)
# BUILD on host ONCE (~/9router/.bgbuild = standalone artifact ~230M),
# standby volume gets a THIN copy of the artifact (no source, no build in panel).
set -u

REPO="/home/agentuser/9router"
NODE_UUID="100.64.1.3"
WINGS="http://127.0.0.1:8085"
WINGS_TOKEN_FILE="/home/agentuser/.wings-token"
LOG="$REPO/.bgswap-panel.log"
STATE="$REPO/.bgswap-panel.state"
LOCK="/tmp/9router-bgswap-panel.lock"
CADDYFILE="/etc/caddy/Caddyfile"
DRAIN_MAX=120
BUILD_IMAGE="ghcr.io/parkervcp/yolks:nodejs_24"
ARTIFACT="$REPO/.bgbuild"

A_IDENT="ab82d038-f0a9-4b47-9810-c9b5787a5886"; A_PORT=3100
B_IDENT="1c0ca6d6-e4bc-44a1-b417-41660d9c4121"; B_PORT=3101
A_VOL="/var/lib/pterodactyl/volumes/$A_IDENT"
B_VOL="/var/lib/pterodactyl/volumes/$B_IDENT"

log(){ echo "[$(date '+%F %T')] $*" >> "$LOG"; }
W=$(cat "$WINGS_TOKEN_FILE" 2>/dev/null || true)
[ -n "$W" ] || { log "FATAL: no wings token"; exit 1; }
mkdir "$LOCK" 2>/dev/null || { log "another deploy running"; exit 1; }
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

power(){
  curl -s -m 30 -X POST "$WINGS/api/servers/$1/power" \
    -H "Authorization: Bearer $W" -H "Content-Type: application/json" \
    --data "{\"action\":\"$2\"}" -o /dev/null
}
wait_state(){
  local i=0 st
  while [ $i -lt "$3" ]; do
    st=$(curl -s -m 10 "$WINGS/api/servers/$1" -H "Authorization: Bearer $W" | grep -o '"state":"[a-z]*"' | head -1 | cut -d'"' -f4)
    if [ "$2" = up ] && [ "$st" = running ]; then return 0; fi
    if [ "$2" = down ] && { [ "$st" = offline ] || [ -z "$st" ]; }; then return 0; fi
    sleep 5; i=$((i+5))
  done
  return 1
}
wait_http(){
  local i=0
  while [ $i -lt "$2" ]; do
    [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$NODE_UUID:$1/login")" = "200" ] && return 0
    sleep 5; i=$((i+5))
  done
  return 1
}
caddy_active(){ grep -q "reverse_proxy $NODE_UUID:$B_PORT" "$CADDYFILE" && echo B || echo A; }
caddy_flip(){
  sudo sed -i "s|reverse_proxy $NODE_UUID:310[01]|reverse_proxy $NODE_UUID:$1|" "$CADDYFILE" \
    && sudo systemctl reload caddy
}

ACTIVE=$(cat "$STATE" 2>/dev/null || caddy_active)
if [ "$ACTIVE" = "B" ]; then
  SA=$A_IDENT; SB=$B_IDENT; PA=$B_PORT; PB=$A_PORT; VB=$A_VOL
else
  SA=$B_IDENT; SB=$A_IDENT; PA=$A_PORT; PB=$B_PORT; VB=$B_VOL
fi
log "=== deploy start; ACTIVE=$ACTIVE (standby will be rebuilt & swapped in) ==="

# 1. pull latest code
cd "$REPO" || exit 1
git pull --ff-only >> "$LOG" 2>&1 || log "WARN: git pull failed, using current tree"

# 2. BUILD ONCE on host (docker nodejs_24). Artifact = standalone + static + public.
log "host build starting ..."
rm -rf "$ARTIFACT"; mkdir -p "$ARTIFACT/.next"
sudo mkdir -p "$REPO/.next" && sudo chown 995:995 "$REPO/.next"
if ! sudo docker run --rm --user 995:995 -v "$REPO":/app -w /app \
     -e HOME=/tmp -e DATA_DIR=/tmp/.9router \
     "$BUILD_IMAGE" bash -c '
       npm install --registry=https://registry.npmjs.org --prefer-offline --no-audit --no-fund >/dev/null 2>&1
       npm run build >/dev/null 2>&1
       [ -f .next/BUILD_ID ] && [ -f .next/standalone/server.js ] && echo BUILD-OK
     ' | grep -q BUILD-OK; then
  log "FATAL: host build failed"; exit 1
fi
sudo cp -a "$REPO/.next/standalone/." "$ARTIFACT/"
sudo cp -a "$REPO/.next/static" "$ARTIFACT/.next/static"
sudo cp -a "$REPO/public" "$ARTIFACT/public"
[ -f "$ARTIFACT/server.js" ] || { log "FATAL: artifact missing server.js"; exit 1; }
# src/ raw imports need full runtime deps; standalone tracing misses some.
# Hardlink complete node_modules from proven full install on ACTIVE volume.
AV_NM="$([ "$ACTIVE" = B ] && echo "$A_VOL" || echo "$B_VOL")/node_modules"
if [ -d "$AV_NM/uuid" ]; then
  sudo rm -rf "$ARTIFACT/node_modules"
  sudo cp -al "$AV_NM" "$ARTIFACT/node_modules"
  sudo chown -R agentuser:agentuser "$ARTIFACT/node_modules"
  log "node_modules hardlinked from active volume"
fi
# .env: dari repo (sumber kebenaran), buang DATA_DIR override (shared DB mount), force bind 0.0.0.0
grep -v '^DATA_DIR=' "$REPO/.env" > "$ARTIFACT/.env" 2>/dev/null || sudo cp "$REPO/.env" "$ARTIFACT/.env"
grep -q '^HOSTNAME=' "$ARTIFACT/.env" && sudo sed -i 's/^HOSTNAME=.*/HOSTNAME=0.0.0.0/' "$ARTIFACT/.env" || echo 'HOSTNAME=0.0.0.0' | sudo tee -a "$ARTIFACT/.env" >/dev/null
sudo chown agentuser:agentuser "$ARTIFACT/.env"
sudo chown -R agentuser:agentuser "$ARTIFACT"
log "host build OK ($(du -sh "$ARTIFACT" | cut -f1))"

# 3. deploy thin artifact into standby volume (clear + copy)
VB_NAME=$([ "$SA" = "$B_IDENT" ] && echo "9router-b" || echo "9router-a")
log "deploying artifact to standby volume $VB_NAME ..."
sudo find "$VB" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null
sudo cp -al "$ARTIFACT/." "$VB/"   # hardlink: volume hampir 0 extra storage
sudo cp "$ARTIFACT/.env" "$VB/.env"
if [ "$SA" = "$A_IDENT" ]; then sudo sed -i "s/^PORT=.*/PORT=$A_PORT/" "$VB/.env"; else sudo sed -i "s/^PORT=.*/PORT=$B_PORT/" "$VB/.env"; fi
sudo chown -R 995:995 "$VB"
# runtime dirs: app writes .9router/logs etc (db comes from panel mount)
sudo mkdir -p "$VB/.9router/logs" "$VB/.9router/db"
sudo chown -R 995:987 "$VB/.9router"

# 4. start standby, wait healthy
power "$SA" start
# wings state flaps during npm-install boot phase; judge by HTTP health only
if ! wait_http "$PB" 600; then
  log "WARN: no HTTP health after 600s - direct restart retry"
  power "$SA" stop; sleep 5; power "$SA" start
  wait_http "$PB" 600 || { log "FATAL: standby failed to boot"; exit 1; }
fi
CHUNK=$(sudo ls "$VB/.next/static/chunks/" 2>/dev/null | grep '\.js$' | head -1)
if [ -n "$CHUNK" ] && [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$NODE_UUID:$PB/_next/static/chunks/$CHUNK")" != "200" ]; then
  log "FATAL: chunk JS 404 - stale build"; power "$SA" stop; exit 1
fi
log "standby healthy on :$PB"

# 5. flip Caddy
caddy_flip "$PB" || { log "FATAL: caddy flip failed"; exit 1; }
sleep 2
if [ "$(curl -s -m 8 -o /dev/null -w '%{http_code}' https://ai.teru.my.id/login)" != "200" ]; then
  log "FATAL: public check failed after flip - rolling back"
  caddy_flip "$([ "$ACTIVE" = B ] && echo "$B_PORT" || echo "$A_PORT")"
  exit 1
fi
log "traffic flipped to :$PB"

# 6. drain old active
i=0
while [ $i -lt $DRAIN_MAX ]; do
  N=$(ss -tn state established "( dport = :$PA or sport = :$PA )" 2>/dev/null | grep -c 100.64.1.3 || true)
  [ "${N:-0}" = "0" ] && break
  sleep 5; i=$((i+5))
done
log "drain done (${i}s)"

# 7. stop old active
power "$SB" stop
if ! wait_state "$SB" down 60; then
  sudo docker stop --time 20 "$SB" >/dev/null 2>&1 || true
  wait_state "$SB" down 30 || log "WARN: old active didn't stop cleanly"
fi

echo "$([ "$SA" = "$B_IDENT" ] && echo B || echo A)" > "$STATE"
log "=== deploy done; NEW ACTIVE=$(cat $STATE) ==="
