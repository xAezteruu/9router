#!/usr/bin/env bash
# auto-merge upstream serenhope/9router -> xAezteruu/9router master
# Runs via cron/systemd timer. Merge only; push happens manually until SSH key added.
set -uo pipefail
REPO="$HOME/9router"
LOG="$REPO/.automerge.log"
LOCK=/tmp/9router-automerge.lock
BRANCH="master"
UPSTREAM="upstream/master"

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
    pm2 restart 9router >/dev/null 2>&1
    sleep 5
    if curl -sf -o /dev/null http://localhost:3000/dashboard; then
      echo "DEPLOY OK — merged $BEHIND commits, build+restart healthy"
      exit 0
    else
      echo "WARN: restart done but /dashboard not responding"
      exit 1
    fi
  else
    echo "BUILD FAILED after clean merge — rolling back"
    git reset --hard ORIG_HEAD
    npm install --registry=https://registry.npmjs.org --prefer-offline >/dev/null 2>&1
    npm run build >/dev/null 2>&1 && pm2 restart 9router >/dev/null 2>&1
    exit 1
  fi
else
  # conflicts: abort to keep prod safe; notify via log (add telegram later)
  echo "CONFLICTS — aborting merge, needs manual resolve"
  git merge --abort
  exit 1
fi
