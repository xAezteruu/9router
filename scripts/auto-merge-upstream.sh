#!/usr/bin/env bash
# auto-merge upstream serenhope/9router -> xAezteruu/9router master
# Runs via cron/systemd timer. Merge only; push happens manually until SSH key added.
set -uo pipefail
REPO="$HOME/9router"
LOG="$REPO/.automerge.log"
LOCK=/tmp/9router-automerge.lock
BRANCH="master"
UPSTREAM="upstream/master"

# Telegram notify (token & chat di ~/.hermes/.env, never logged)
TG_ENV="$HOME/.hermes/.env"
tg_notify() { # $1 = message
  if [ -f "$TG_ENV" ]; then
    local token chat
    token=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$TG_ENV" | cut -d= -f2-)
    chat=$(grep -E '^TELEGRAM_ALLOWED_USERS=' "$TG_ENV" | cut -d= -f2- | cut -d, -f1)
    [ -n "$token" ] && [ -n "$chat" ] && \
      curl -sf -m 10 "https://api.telegram.org/bot${token}/sendMessage" \
        -d chat_id="$chat" -d text="[9router automerge] $1" >/dev/null 2>&1
  fi
}

exec >>"$LOG" 2>&1
echo "=== $(date -Is) automerge run ==="

# single instance
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "already running, skip"; exit 0
fi
trap 'rmdir "$LOCK"' EXIT

cd "$REPO" || { echo "FATAL: repo missing"; exit 1; }

# skip if working tree dirty
if [ -n "$(git status --porcelain | grep -v '^??')" ]; then
  echo "working tree dirty, skip"; exit 1
fi

git fetch upstream 2>&1 | tail -1 || { echo "fetch failed"; exit 1; }

BEHIND=$(git rev-list --count HEAD..$UPSTREAM)
if [ "$BEHIND" -eq 0 ]; then
  echo "up to date"; exit 0
fi
echo "behind upstream by $BEHIND commits — merging"

git merge --no-edit $UPSTREAM
MERGE_EXIT=$?

if [ $MERGE_EXIT -eq 0 ]; then
  echo "clean merge, rebuilding"
  npm install --registry=https://registry.npmjs.org --prefer-offline --no-audit --no-fund >/dev/null 2>&1
  if npm run build >/dev/null 2>&1; then
    # blue-green: update standby -> flip -> update old primary -> flip back (zero downtime)
    if "$REPO/deploy/bgDeploy.sh" 1 >>"$LOG" 2>&1; then
      echo "DEPLOY OK (blue-green) — merged $BEHIND commits"
      tg_notify "✅ DEPLOY OK (blue-green) — merged $BEHIND commit(s) dari upstream, kedua node sehat di versi baru"
    else
      echo "bgDeploy reported failure — see .bgdeploy.log"
      tg_notify "⚠️ bgDeploy bermasalah setelah merge $BEHIND commit(s) — cek .bgdeploy.log"
    fi
    exit 0
  else
    echo "BUILD FAILED after clean merge — rolling back"
    tg_notify "⚠️ BUILD FAILED setelah merge $BEHIND commit(s) — ROLLBACK ke ORIG_HEAD, prod tetap versi lama"
    git reset --hard ORIG_HEAD
    npm install --registry=https://registry.npmjs.org --prefer-offline >/dev/null 2>&1
    npm run build >/dev/null 2>&1 && "$REPO/deploy/bgDeploy.sh" 1 >>"$LOG" 2>&1
    exit 1
  fi
else
  # conflicts: abort to keep prod safe, then hand off to a Hermes agent session
  echo "CONFLICTS — aborting merge, needs manual resolve"
  tg_notify "❌ CONFLICT merging $BEHIND commit(s) dari upstream — merge di-ABORT, prod tetap jalan versi lama. Dispatching agent buat resolve..."
  git merge --abort

  # dispatch agent to auto-resolve conflicts in a scratch clone (prod untouched)
  AGENT_LOG="$REPO/.automerge-agent.log"
  {
    echo "=== $(date -Is) agent dispatch for conflict resolution ==="
    hermes chat -q "$(cat <<EOF
Resolve the git merge conflicts between our fork and upstream in a THROWAWAY clone, then report back. Rules:

1. Clone the repo fresh: git clone $REPO /tmp/automerge-resolve-$$ && cd there.
2. git remote add upstream https://github.com/serenhope/9router.git && git fetch upstream
3. git merge upstream/master (this will conflict — that's the point).
4. Resolve conflicts following THESE conventions (established over multiple merges):
   - src/lib/plugins/customPluginsRuntime.js: KEEP FORK side (unrestrictedMode, speedMode, processCoderFocus, imageVision, thinkDeeper, systemPrompts dispatch), but ADD any new upstream plugin blocks (e.g. adaptiveThinking) into DEFAULT_PLUGINS and dispatch.
   - open-sse/providers/registry/index.js: REGENERATE the file instead of hand-merging (python: import all registry/*.js sorted alphabetically as p0..pN, export default array) — upstream frequently ships duplicate imports.
   - src/shared/constants/pluginKeys.js + PLUGIN_MARK_META in models.js: UNION of fork + upstream keys.
   - src/app/(dashboard)/dashboard/plugins/page.js + src/app/api/plugins/route.js: upstream side (UI follows upstream).
   - Everything else: upstream side unless it's fork-feature code (unrestrictedMode/speedMode/coderFocus/tokenharbor) — those keep fork.
   - Never leave <<<<<<< markers. Verify each resolved file parses: npx esbuild <file> --format=esm --outfile=/dev/null
5. npm install --registry=https://registry.npmjs.org --prefer-offline --no-audit --no-fund
6. npm run build — MUST succeed. If build fails, fix and retry up to 3 times.
7. If everything passes: commit with message "merge: upstream <short-sha> (auto-resolved by agent)" and LEAVE the commits in the local clone at /tmp/automerge-resolve-$$ — do NOT push (no credentials). Print the resolved commit SHA and the clone path clearly at the end.
8. If you cannot resolve or build keeps failing: do NOT commit, print exactly "AGENT-RESOLVE-FAILED: <reason>".

Do not touch $REPO itself — the merge there stays aborted; a human applies the resolved clone.
EOF
)" 2>&1
    echo "=== agent dispatch done, exit=$? ==="
  } >> "$AGENT_LOG" 2>&1

  # relay agent result to Telegram
  if grep -q "AGENT-RESOLVE-FAILED" "$AGENT_LOG" 2>/dev/null && tail -20 "$AGENT_LOG" | grep -q "AGENT-RESOLVE-FAILED"; then
    tg_notify "🤖 Agent GAGAL resolve konflik: $(tail -20 "$AGENT_LOG" | grep 'AGENT-RESOLVE-FAILED' | tail -1 | cut -c1-200). Perlu manual."
  else
    RESULT=$(tail -30 "$AGENT_LOG" | grep -oE '[0-9a-f]{40}|\bmerge: upstream [^\"]*' | tail -1)
    tg_notify "🤖 Agent selesai resolve konflik. Result: ${RESULT:-cek $AGENT_LOG}. Clone siap-review di /tmp (commit belum diterapkan ke prod — gabungkan manual atau bilang 'apply hasil agent')."
  fi
  exit 1
fi
