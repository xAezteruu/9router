#!/usr/bin/env bash
# bgDeploy.sh — blue-green deploy: update standby, flip, update primary, flip back
# usage: bgDeploy.sh [notify]
#   notify=1 → send Telegram updates per step
set -uo pipefail
REPO="/home/agentuser/9router"
DEPLOY="$REPO/deploy"
NOTIFY="${1:-1}"
LOG="$REPO/.bgdeploy.log"

TG_ENV="$HOME/.hermes/.env"
tg() { # $1 message
  [ "$NOTIFY" = "1" ] || return 0
  local token chat
  token=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$TG_ENV" 2>/dev/null | cut -d= -f2-)
  chat=$(grep -E '^TELEGRAM_ALLOWED_USERS=' "$TG_ENV" 2>/dev/null | cut -d= -f2- | cut -d, -f1)
  [ -n "$token" ] && [ -n "$chat" ] && \
    curl -sf -m 10 "https://api.telegram.org/bot${token}/sendMessage" \
      -d chat_id="$chat" -d text="[9router bg-deploy] $1" >/dev/null 2>&1
}

log() { echo "[$(date -Is)] $*" >> "$LOG"; }

which_bg() { # prints a or b — the node Caddy currently points to (source of truth: /etc/caddy/Caddyfile)
  sudo grep -q 'reverse_proxy 127.0.0.1:3100' /etc/caddy/Caddyfile && echo a || echo b
}

other() { [ "$1" = "a" ] && echo b || echo a; }
port_of() { [ "$1" = "a" ] && echo 3100 || echo 3101; }

restart_node() { # $1 = a|b
  local n="$1" p; p=$(port_of "$n")
  pm2 restart "9router-${n}" --update-env >/dev/null 2>&1 \
    || pm2 start "$REPO/custom-server.js" --name "9router-${n}" --cwd "$REPO" --update-env --env production -- --port "$p" >/dev/null 2>&1
}

# custom-server.js reads PORT env; ensure each node binds its port via PM2 env
ensure_node_env() {
  # node a
  pm2 delete 9router-a >/dev/null 2>&1 || true
  PORT=3100 pm2 start "$REPO/custom-server.js" --name 9router-a --cwd "$REPO" --env production >/dev/null 2>&1
  # node b
  pm2 delete 9router-b >/dev/null 2>&1 || true
  PORT=3101 pm2 start "$REPO/custom-server.js" --name 9router-b --cwd "$REPO" --env production >/dev/null 2>&1
}

exec >>"$LOG" 2>&1
log "=== bgDeploy start (notify=$NOTIFY) ==="

ACTIVE=$(which_bg)
STANDBY=$(other "$ACTIVE")
log "active=$ACTIVE standby=$STANDBY"

# -------- STEP 1: update standby --------
SP=$(port_of "$STANDBY")
log "step1: update node $STANDBY (:${SP})"
tg "1/5 Update node ${STANDBY^^} (standby)..."

restart_node "$STANDBY"
sleep 6

# -------- STEP 2: warm & verify standby --------
HEALTH=""
for i in $(seq 1 12); do
  HEALTH=$("$DEPLOY/bg-health.sh" "$SP") && break
  sleep 5
done
if ! "$DEPLOY/bg-health.sh" "$SP" >/dev/null 2>&1; then
  log "step2 FAIL: standby $STANDBY unhealthy: $HEALTH"
  tg "❌ Node ${STANDBY^^} gagal health check setelah update — BATAL, traffic tetap di ${ACTIVE^^}. Prod aman."
  exit 1
fi
log "step2: standby healthy: $HEALTH"

# -------- STEP 3: flip to standby --------
if ! "$DEPLOY/bgSetActive.sh" "$STANDBY" >>"$LOG" 2>&1; then
  log "step3 FAIL: flip refused (target was unhealthy)"
  tg "❌ Flip ke ${STANDBY^^} ditolak (target unhealthy). Traffic tetap di ${ACTIVE^^}."
  exit 1
fi
ACTIVE="$STANDBY"
log "step3: traffic flipped to $ACTIVE"
OLD=$(other "$STANDBY")
tg "🔄 Traffic pindah ke ${STANDBY^^} (versi BARU). Sekarang update ${OLD^^}..."

# -------- STEP 4: update old primary --------
OP=$(port_of "$OLD")
log "step4: update node $OLD (:${OP})"
restart_node "$OLD"
sleep 6

# -------- STEP 5: verify old node, flip back if healthy --------
for i in $(seq 1 12); do
  HEALTH=$("$DEPLOY/bg-health.sh" "$OP") && break
  sleep 5
done
if "$DEPLOY/bg-health.sh" "$OP" >/dev/null 2>&1; then
  if "$DEPLOY/bgSetActive.sh" "$OLD" >>"$LOG" 2>&1; then
    ACTIVE="$OLD"
    log "step5: flipped back to primary $ACTIVE — both nodes healthy on NEW version"
    tg "✅ DEPLOY SELESAI — kedua node sehat di versi baru. Traffic kembali ke ${ACTIVE^^} (primary), ${STANDBY^^} standby."
  else
    log "step5 WARN: old node healthy but flip back failed — staying on $ACTIVE"
    tg "⚠️ Node lama sehat tapi flip-back gagal. Traffic tetap di ${ACTIVE^^} (jalan normal)."
  fi
else
  log "step5 WARN: old node $OLD unhealthy after update — traffic stays on $ACTIVE (new version)"
  tg "⚠️ Node lama ${OLD^^} unhealthy setelah update — traffic TETAP di ${ACTIVE^^} (versi baru, jalan normal). Node lama butuh dicek."
fi

log "=== bgDeploy done, active=$ACTIVE ==="
exit 0
