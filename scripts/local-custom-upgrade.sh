#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${OPENCLAW_CUSTOM_PORT:-18789}"
RESTART_GATEWAY=1
FETCH_TAGS=1
TARGET_TAG=""

# Keep customizations as distinct commits so upgrades can cherry-pick them forward.
CUSTOM_COMMIT_SUBJECTS=(
  "Feishu: suppress sender-name permission spam and strip reasoning"
  "Weather: make chat-safe wttr usage defaults"
)

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/local-custom-upgrade.sh [--tag vYYYY.M.D] [--port 18789] [--no-restart] [--no-fetch]

Upgrades the local custom OpenClaw checkout to a target stable tag, then reapplies
the local customization commits by cherry-pick and optionally restarts the gateway.

Options:
  --tag <tag>       Target tag (default: latest stable vYYYY.M.D tag found locally/fetched)
  --port <port>     Gateway port to restart (default: 18789)
  --no-restart      Do not restart gateway after upgrade
  --no-fetch        Skip `git fetch --tags origin`
  -h, --help        Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      [[ $# -ge 2 ]] || fail "--tag requires a value"
      TARGET_TAG="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || fail "--port requires a value"
      PORT="$2"
      shift 2
      ;;
    --no-restart)
      RESTART_GATEWAY=0
      shift
      ;;
    --no-fetch)
      FETCH_TAGS=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

cd "$ROOT_DIR"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Not a git repository: $ROOT_DIR"

if [[ -n "$(git status --porcelain)" ]]; then
  fail "Working tree is not clean. Commit or stash local changes before upgrading."
fi

if [[ "$FETCH_TAGS" -eq 1 ]]; then
  log "==> Fetching tags from origin"
  git fetch --tags origin
fi

if [[ -z "$TARGET_TAG" ]]; then
  TARGET_TAG="$(git tag --list 'v*' --sort=-v:refname | rg '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n1)"
fi

[[ -n "$TARGET_TAG" ]] || fail "Could not determine target tag"
git rev-parse "${TARGET_TAG}^{commit}" >/dev/null 2>&1 || fail "Tag not found: $TARGET_TAG"

BRANCH_NAME="local/${TARGET_TAG#v}-custom"
log "==> Target tag: $TARGET_TAG"
log "==> Target custom branch: $BRANCH_NAME"

if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
  log "==> Switching to existing branch $BRANCH_NAME"
  git switch "$BRANCH_NAME"
else
  log "==> Creating branch $BRANCH_NAME from $TARGET_TAG"
  git switch -c "$BRANCH_NAME" "$TARGET_TAG"
fi

for subject in "${CUSTOM_COMMIT_SUBJECTS[@]}"; do
  commit_hash="$(git log --all --format=%H --grep="^${subject}$" -n1 || true)"
  [[ -n "$commit_hash" ]] || fail "Custom commit not found by subject: $subject"

  if git merge-base --is-ancestor "$commit_hash" HEAD; then
    log "==> Already present: $subject ($commit_hash)"
    continue
  fi

  log "==> Cherry-picking: $subject ($commit_hash)"
  git cherry-pick -x "$commit_hash"
done

log "==> Installing dependencies"
pnpm install

log "==> Running focused Feishu regression tests"
pnpm vitest extensions/feishu/src/bot.test.ts
pnpm vitest extensions/feishu/src/reply-dispatcher.test.ts

if [[ "$RESTART_GATEWAY" -eq 1 ]]; then
  log "==> Restarting gateway on port $PORT"
  pids="$(lsof -tiTCP:${PORT} -sTCP:LISTEN || true)"
  if [[ -n "$pids" ]]; then
    kill $pids || true
    sleep 1
  fi
  nohup pnpm openclaw gateway run --bind loopback --port "$PORT" --force >/tmp/openclaw-gateway-custom.log 2>&1 &
  sleep 2
  if ! lsof -nP -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
    fail "Gateway did not start on port $PORT (check /tmp/openclaw-gateway-custom.log)"
  fi
  log "==> Gateway restarted (log: /tmp/openclaw-gateway-custom.log)"
fi

log "==> Done"
log "    Repo: $ROOT_DIR"
log "    Branch: $(git rev-parse --abbrev-ref HEAD)"
log "    Version: $(pnpm openclaw --version | tail -n1)"
