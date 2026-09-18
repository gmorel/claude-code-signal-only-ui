#!/usr/bin/env bash
# Runs the e2e suite from a scratch mirror of this repository.
#
# Why a mirror: a node_modules directory next to the plugin changes what
# --plugin-dir loads, so the tree is rsynced to $TMPDIR, dependencies are
# installed there, and `bun test` runs there.
#
# Why a seeded config: an e2e run starts a real `claude`, and it must never
# open the reader's own ~/.claude — not the account, not the history, not the
# projects. CLAUDE_CONFIG_DIR points at a throwaway config inside the mirror
# that has already accepted onboarding, the mock API key and the trust dialog
# for the mirror path, so no dialog stands in front of the card.
#
#   bash scripts/e2e.sh                 run the suite
#   bash scripts/e2e.sh --prepare       mirror + install + seed only, print the mirror path
#   bash scripts/e2e.sh -t 'receipt'      anything else is passed on to `bun test`
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="${TMPDIR:-/tmp}"
MIRROR_RAW="${SOU_E2E_DIR:-${TMP%/}/signal-only-ui-e2e}"
MIRROR_RAW="${MIRROR_RAW%/}"

prepare_only=0
if [[ "${1:-}" == "--prepare" ]]; then
  prepare_only=1
  shift
fi

# --prepare prints the mirror path on stdout and nothing else: a caller reads it
say() { if [[ $prepare_only == 0 ]]; then printf '%s\n' "$*" >&2; fi; }

mkdir -p "$MIRROR_RAW"
# the path Claude Code will key its project entry under is the resolved one
# ($TMPDIR lives under the /var → /private/var symlink on macOS)
MIRROR="$(cd "$MIRROR_RAW" && pwd -P)"
CONFIG="$MIRROR/e2e-config"

# --exclude keeps node_modules and the seeded config out of --delete's reach,
# so a second run reuses both instead of reinstalling
say "mirror  $MIRROR"
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'e2e-config' \
  "$REPO/" "$MIRROR/"

cd "$MIRROR"

# install only when the manifest moved: a run is minutes of tmux, not of npm
stamp="node_modules/.signal-e2e-stamp"
want="$(shasum package.json | cut -d' ' -f1)"
if [[ ! -f "$stamp" || "$(cat "$stamp")" != "$want" ]]; then
  say "install $MIRROR/node_modules"
  # `npm ci` is the reproducible one and is used whenever a lockfile came across;
  # it refuses without one, and this repository ships none yet, so npm resolves instead
  npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null
  mkdir -p node_modules
  printf '%s' "$want" > "$stamp"
fi

mkdir -p "$CONFIG"
trusted="\"$MIRROR\": { \"hasTrustDialogAccepted\": true, \"allowedTools\": [], \"mcpServers\": {} }"
# both spellings when they differ, because which one the engine keys under is its business, not ours
if [[ "$MIRROR_RAW" != "$MIRROR" ]]; then
  trusted="$trusted,
    \"$MIRROR_RAW\": { \"hasTrustDialogAccepted\": true, \"allowedTools\": [], \"mcpServers\": {} }"
fi
cat > "$CONFIG/.claude.json" <<JSON
{
  "hasCompletedOnboarding": true,
  "theme": "dark",
  "numStartups": 10,
  "autoUpdates": false,
  "customApiKeyResponses": { "approved": ["mock"], "rejected": [] },
  "projects": {
    $trusted
  }
}
JSON
cat > "$CONFIG/settings.json" <<'JSON'
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1" } }
JSON
export CLAUDE_CONFIG_DIR="$CONFIG"

if [[ $prepare_only == 1 ]]; then
  printf '%s\n' "$MIRROR"
  exit 0
fi

missing=()
command -v tmux >/dev/null || missing+=("tmux")
command -v claude >/dev/null || missing+=("claude")
command -v rsync >/dev/null || missing+=("rsync")
command -v npm >/dev/null || missing+=("npm")
command -v bun >/dev/null || missing+=("bun")
command -v node >/dev/null || missing+=("node")
if ((${#missing[@]} > 0)); then
  printf 'e2e preflight: missing required tool(s): %s\n' "${missing[*]}" >&2
  exit 1
fi

say "config  $CONFIG"
say "run     bun test tests/e2e"
exec bun test tests/e2e "$@"
