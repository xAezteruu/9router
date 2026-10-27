#!/usr/bin/env bash
# bgDeploy.sh v2 — alur: git pull → build → ship standby (B) → flip caddy →
#                  drain A → stop A → ship primary (A) → flip balik → drain B → stop B
# End state: A aktif (primary), B standby mati. Keduanya versi baru.
# usage: bgDeploy.sh [notify]
#   notify=1 → Telegram updates per step
set -uo pipefail
REPO="/home/agentuser/9router"
DEPLOY="$REPO/deploy"
NOTIFY="${1:-1}"
LOG="$REPO/.bgdeploy.log"
TS_IP="100.64.1.3"

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

# node a = :3100 (primary), node b = :3101 (standby) — keduanya container Ptero
port_of()  { [ "$1" = "a" ] && echo 3100 || echo 3101; }
cid_of()   { # container NAME (bukan ID — volume pterodactyl pakai nama penuh UUID)
  for c in $(sudo docker ps -aq); do
    sudo docker inspect "$c" --format '{{json .HostConfig.PortBindings}}' 2>/dev/null \
      | grep -q "\"${1}/tcp\"" && { sudo docker inspect "$c" --format '{{.Name}}' | sed 's|/||'; return 0; }
  done
  return 1
}
which_bg() { # node yang sedang dilayani caddy
  sudo grep -q "reverse_proxy ${TS_IP}:3100" /etc/caddy/Caddyfile && echo a || echo b
}

health() { bash "$DEPLOY/bg-health.sh" "$1" >/dev/null 2>&1; }

sync_build() { # $1 = volume path — build artifact saja, TANPA node_modules & TANPA dotfiles runtime
  sudo rsync -a --delete \
    --exclude node_modules --exclude .git --exclude .local \
    --exclude .npm --exclude .config --exclude .env \
    --exclude '.env.*' --exclude logs --exclude deploy \
    --exclude '.9router' --exclude '.cache' --exclude '.pm2' \
    --exclude '.automerge*' --exclude '.bgdeploy.log' --exclude '.bgswap*' \
    --exclude 'tests' --exclude 'docs' --exclude 'images' --exclude 'gitbook' \
    --exclude 'cli' --exclude 'ecosystem*' --exclude '.next/cache' \
    "$REPO/" "$1/"
}

refresh_nm() { # $1 = volume path — hardlink ulang node_modules host (hemat disk, ikut versi baru)
  sudo rm -rf "$1/node_modules"
  sudo cp -al "$REPO/node_modules" "$1/node_modules"
}

start_node() { # $1 = a|b — stop → refresh nm → build sync → start → health
  local n="$1" p cid vol
  p=$(port_of "$n"); cid=$(cid_of "$p"); vol="/var/lib/pterodactyl/volumes/$cid"
  [ -n "$cid" ] || { log "start_node FAIL: container node $n tidak ketemu"; return 1; }
  sudo docker stop "$cid" >/dev/null 2>&1
  refresh_nm "$vol" || return 1
  sync_build "$vol" || return 1
  sudo docker start "$cid" >/dev/null 2>&1
  for i in $(seq 1 12); do health "$p" && return 0; sleep 5; done
  log "start_node FAIL: node $n unhealthy: $(bash "$DEPLOY/bg-health.sh" "$p" 2>&1 | tail -1)"
  return 1
}

drain() { # $1 = a|b — tunggu sampai node tidak ada request lagi (max 180s, lalu paksa)
  local n="$1" p cid quiet=0 elapsed=0 hits
  p=$(port_of "$n"); cid=$(cid_of "$p")
  log "drain node $n (:${p})..."
  while [ $elapsed -lt 180 ]; do
    hits=$(sudo docker logs --since 8s "$cid" 2>&1 | grep -cE "▶|POST|GET /" || true)
    if [ "$hits" -eq 0 ]; then
      quiet=$((quiet+1))
      [ $quiet -ge 2 ] && { log "drain: node $n quiet ${elapsed}s — aman dimatikan"; return 0; }
    else
      quiet=0
    fi
    sleep 8; elapsed=$((elapsed+8))
  done
  log "drain WARN: node $n masih ada traffic setelah 180s — paksa lanjut"
  return 0
}

exec >>"$LOG" 2>&1
log "=== bgDeploy v2 start (notify=$NOTIFY) ==="
tg "🚀 Deploy mulai: git pull → build → B → flip → A → flip balik"

# -------- STEP 0: git pull dari upstream (conflict: upstream menang, package.json tetap fork) --------
cd "$REPO" || exit 1
LOCK_BEFORE=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1)
git fetch upstream >>"$LOG" 2>&1 \
  || { log "step0 FAIL: git fetch upstream"; tg "❌ git fetch gagal — deploy dibatalkan, prod aman"; exit 1; }
BEHIND=$(git rev-list --count HEAD..upstream/master 2>/dev/null || echo 0)
if [ "$BEHIND" -eq 0 ]; then
  log "step0: sudah up-to-date dengan upstream/master (behind=0)"
else
  if ! git merge upstream/master --no-edit -X theirs >>"$LOG" 2>&1; then
    if git status --porcelain | grep -q '^UU'; then
      git checkout --theirs . >/dev/null 2>&1
      git checkout --ours package.json >/dev/null 2>&1
      git add -A && git commit -m "chore: merge upstream (keep fork package.json)" >>"$LOG" 2>&1 || true
      log "git merge: conflict di-resolve (upstream wins, package.json fork)"
    else
      log "step0 FAIL: git merge gagal total"
      tg "❌ git merge gagal — deploy dibatalkan, prod aman"
      exit 1
    fi
  fi
  log "step0: merged upstream/master ($BEHIND commits)"
fi
LOCK_AFTER=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1)
log "step0: git pull OK (lock changed: $([ "$LOCK_BEFORE" != "$LOCK_AFTER" ] && echo yes || echo no))"

# -------- STEP 1: npm install (hanya kalau lockfile berubah) + build --------
if [ "$LOCK_BEFORE" != "$LOCK_AFTER" ]; then
  tg "📦 npm install (lockfile berubah)..."
  npm install --registry=https://registry.npmjs.org --no-audit --no-fund >>"$LOG" 2>&1 \
    || { log "step1 FAIL: npm install"; tg "❌ npm install gagal — prod aman"; exit 1; }
fi
tg "🔨 Build..."
npm run build >>"$LOG" 2>&1 \
  || { log "step1 FAIL: build"; tg "❌ Build gagal — prod aman, tidak ada flip"; exit 1; }
log "step1: build OK"

ACTIVE=$(which_bg)   # harusnya b
STANDBY=$( [ "$ACTIVE" = "a" ] && echo b || echo a )
log "state: active=$ACTIVE standby=$STANDBY"

# -------- STEP 2: ship build + aktifkan node standby (B) --------
tg "2/5 Update & aktifkan node ${STANDBY^^} (standby)..."
if ! start_node "$STANDBY"; then
  log "step2 FAIL: standby $STANDBY gagal"; tg "❌ Node ${STANDBY^^} gagal — prod tetap di ${ACTIVE^^}"
  exit 1
fi
log "step2: node $STANDBY up & healthy"

# -------- STEP 3: flip caddy ke standby (B) --------
if ! bash "$DEPLOY/bgSetActive.sh" "$STANDBY" >>"$LOG" 2>&1; then
  log "step3 FAIL: flip ditolak"; tg "❌ Flip ke ${STANDBY^^} ditolak — prod tetap di ${ACTIVE^^}"
  exit 1
fi
tg "🔄 Traffic pindah ke ${STANDBY^^} (versi baru). Drain ${ACTIVE^^}..."
log "step3: caddy → $STANDBY"

# -------- STEP 4: drain node A lama → stop → ship build → start --------
drain "$ACTIVE"
p_old=$(port_of "$ACTIVE"); cid_old=$(cid_of "$p_old")
sudo docker stop "$cid_old" >/dev/null 2>&1
log "step4: node $ACTIVE stopped"
if ! start_node "$ACTIVE"; then
  log "step4 FAIL: node $ACTIVE gagal setelah update — traffic tetap di $STANDBY"
  tg "⚠️ Node ${ACTIVE^^} gagal — traffic tetap di ${STANDBY^^} (jalan normal)"
  exit 0
fi
log "step4: node $ACTIVE up & healthy"
tg "4/5 Node ${ACTIVE^^} sehat. Flip balik ke ${ACTIVE^^}..."

# -------- STEP 5: flip balik ke A → drain B → stop B --------
if ! bash "$DEPLOY/bgSetActive.sh" "a" >>"$LOG" 2>&1; then
  log "step5 WARN: flip balik gagal — traffic tetap di $STANDBY"
  tg "⚠️ Flip balik gagal — traffic tetap di ${STANDBY^^}"
  exit 0
fi
sleep 2
drain "$STANDBY"
p_sb=$(port_of "$STANDBY"); cid_sb=$(cid_of "$p_sb")
log "step5: stopping container $cid_sb (node $STANDBY :$p_sb)"
sudo docker stop "$cid_sb" >/dev/null 2>&1
log "step5: node $STANDBY stopped (standby mati, versi baru)"
tg "✅ DEPLOY SELESAI — A aktif (primary), B standby mati. Keduanya versi baru."

log "=== bgDeploy v2 done, active=a ==="
exit 0
