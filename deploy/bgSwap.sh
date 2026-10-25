#!/usr/bin/env bash
# bgSwap.sh — sequential single-active deploy (Aez model):
#   webhook/push → pull+build STANDBY → activate standby (verify) → stop old active
#   → pull+build old (now standby) → activate it back (verify) → stop other → done.
# Invariant: only ONE node serves traffic at a time (except the moment of switch).
# usage: bgSwap.sh [notify]
set -uo pipefail
REPO_A="/home/agentuser/9router"          # node A dir (branch master)
REPO_B="/home/agentuser/9router-b"        # node B dir (worktree deployed-b)
DEPLOY="$REPO_A/deploy"
NOTIFY="${1:-1}"
LOG="$REPO_A/.bgswap.log"
LOCK=/tmp/9router-bgswap.lock
CADDYFILE="/etc/caddy/Caddyfile"

TG_ENV="$HOME/.hermes/.env"
tg() {
  [ "$NOTIFY" = "1" ] || return 0
  local token chat
  token=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$TG_ENV" 2>/dev/null | cut -d= -f2-)
  chat=$(grep -E '^TELEGRAM_ALLOWED_USERS=' "$TG_ENV" 2>/dev/null | cut -d= -f2- | cut -d, -f1)
  [ -n "$token" ] && [ -n "$chat" ] && \
    curl -sf -m 10 "https://api.telegram.org/bot${token}/sendMessage" \
      -d chat_id="$chat" -d text="[9router deploy] $1" >/dev/null 2>&1
}
log() { echo "[$(date -Is)] $*" >> "$LOG"; }

active_of() { sudo grep -o 'reverse_proxy 127.0.0.1:310[01]' "$CADDYFILE" | grep -q 3100 && echo a || echo b; }
port_of() { [ "$1" = "a" ] && echo 3100 || echo 3101; }
dir_of() { [ "$1" = "a" ] && echo "$REPO_A" || echo "$REPO_B"; }
other() { [ "$1" = "a" ] && echo b || echo a; }

activate() { # $1=a|b — point caddy at node (must be healthy), return 0 on success
  local n="$1" p; p=$(port_of "$n")
  "$DEPLOY/bg-health.sh" "$p" >/dev/null 2>&1 || return 1
  sudo python3 - "$p" <<'PYEOF'
import sys, re, pathlib
p = pathlib.Path("/etc/caddy/Caddyfile")
t = p.read_text()
t = re.sub(r"reverse_proxy 127\.0\.0\.1:\d+", f"reverse_proxy 127.0.0.1:{sys.argv[1]}", t)
p.write_text(t)
PYEOF
  sudo caddy reload --config "$CADDYFILE" >/dev/null 2>&1 || return 1
  sleep 1
  local code; code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 http://localhost:3000/dashboard)
  [ "$code" = "200" ] || [ "$code" = "307" ]
}

pull_build() { # $1=a|b — git pull + npm install + build in node dir. 0 = ok
  local n="$1" d; d=$(dir_of "$n")
  # B is a worktree of A: pull from local mainrepo first (always works), then try GitHub (optional, may lack creds)
  if [ "$n" = "b" ]; then
    git -C "$d" fetch mainrepo master >>"$LOG" 2>&1 && git -C "$d" reset --hard mainrepo/master >>"$LOG" 2>&1
  fi
  git -C "$d" pull origin master >>"$LOG" 2>&1 || log "note: GitHub pull skipped for $n (no creds — using local repo state)"
  ( cd "$d" && npm install --registry=https://registry.npmjs.org --prefer-offline --no-audit --no-fund >>"$LOG" 2>&1 ) || return 1
  ( cd "$d" && npm run build >>"$LOG" 2>&1 ) || return 1
  return 0
}

start_node() { # $1=a|b
  local n="$1" d p; d=$(dir_of "$n"); p=$(port_of "$n")
  pm2 describe "9router-$n" >/dev/null 2>&1 \
    && pm2 restart "9router-$n" --update-env >/dev/null 2>&1 \
    || ( cd "$d" && PORT=$p pm2 start custom-server.js --name "9router-$n" --env production >/dev/null 2>&1 )
  pm2 start "9router-$n" >/dev/null 2>&1
}
stop_node() { pm2 stop "9router-$1" >/dev/null 2>&1; }

# drain_node.sh logic inline: wait until node has ~0 established connections (max 120s)
drain_node() { # $1=a|b
  local p; p=$(port_of "$1")
  for i in $(seq 1 24); do
    CONN=$(ss -tn state established "( sport = :$p )" 2>/dev/null | tail -n +2 | wc -l)
    [ "$CONN" -le 1 ] && return 0   # 1 = caddy health-probe conn is fine
    sleep 5
  done
  return 0  # give up waiting, stop anyway (max 2min)
}

exec >>"$LOG" 2>&1
log "=== bgSwap start (notify=$NOTIFY) ==="

# single instance
if ! mkdir "$LOCK" 2>/dev/null; then log "already running, skip"; exit 0; fi
trap 'rmdir "$LOCK"' EXIT

ACTIVE=$(active_of)
STANDBY=$(other "$ACTIVE")
log "active=$ACTIVE standby=$STANDBY"
tg "🚀 Deploy mulai: update node ${STANDBY^^} dulu (traffic tetap di ${ACTIVE^^})..."

# ---- PHASE 1: prepare standby (offline) ----
if ! pull_build "$STANDBY"; then
  log "PHASE1 FAIL: pull/build $STANDBY gagal — traffic tetap di $ACTIVE, nothing touched"
  tg "❌ Build node ${STANDBY^^} gagal — web tetap jalan di ${ACTIVE^^}, gak ada yang berubah."
  exit 1
fi
log "phase1: $STANDBY pulled+built"

# ---- PHASE 2: activate standby ----
start_node "$STANDBY"
sleep 6
for i in $(seq 1 12); do activate "$STANDBY" && break; sleep 5; done
if ! activate "$STANDBY"; then
  log "PHASE2 FAIL: $STANDBY gak sehat setelah build — traffic tetap di $ACTIVE"
  tg "❌ Node ${STANDBY^^} gak sehat setelah update — web tetap jalan di ${ACTIVE^^} (versi lama)."
  stop_node "$STANDBY"
  exit 1
fi
log "phase2: traffic switched to $STANDBY"
tg "🔄 Traffic pindah ke ${STANDBY^^} (versi BARU, terverifikasi). Drain request lama di ${ACTIVE^^}..."

# ---- PHASE 3: drain old node (wait until no in-flight requests), stop, pull+build ----
drain_node "$ACTIVE"
log "phase2b: $ACTIVE drained, stopping"
stop_node "$ACTIVE"
if ! pull_build "$ACTIVE"; then
  log "PHASE3 WARN: pull/build $ACTIVE gagal — $STANDBY tetap melayani traffic"
  tg "⚠️ Update node ${ACTIVE^^} gagal — web jalan normal di ${STANDBY^^}. Node ${ACTIVE^^} butuh dicek."
  exit 1
fi
log "phase3: $ACTIVE pulled+built"

# ---- PHASE 4: activate old node back, then stop the other ----
start_node "$ACTIVE"
sleep 6
for i in $(seq 1 12); do activate "$ACTIVE" && break; sleep 5; done
if activate "$ACTIVE"; then
  drain_node "$STANDBY"
  stop_node "$STANDBY"
  log "phase4: traffic back on $ACTIVE; $STANDBY stopped. FINAL: active=$ACTIVE (single node)"
  tg "✅ DEPLOY SELESAI — traffic di ${ACTIVE^^} (versi baru). Node ${STANDBY^^} dimatiin. 1 node hidup, sesuai alur."
else
  # old node failed after rebuild: fall back to the new one (it was verified healthy)
  log "PHASE4: $ACTIVE gak sehat — fallback balik ke $STANDBY"
  activate "$STANDBY" && stop_node "$ACTIVE"
  log "fallback: active=$STANDBY, $ACTIVE stopped"
  tg "⚠️ Node ${ACTIVE^^} gak sehat pas diaktifin balik — fallback ke ${STANDBY^^} (versi baru). Web jalan normal."
fi
log "=== bgSwap done ==="
exit 0
