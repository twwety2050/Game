#!/usr/bin/env bash
# Keep a local copy of the game in sync with GitHub and serve it.
#
# Usage:  tools/play.sh [folder] [port]
#   folder  where the game lives (default: the checkout this script is in, else ~/VoxelCraft);
#           cloned from GitHub first if it doesn't exist yet
#   port    web server port (default 8000)
# Environment: INTERVAL (seconds between GitHub checks, default 30), REPO_URL, BRANCH.

# Everything runs inside main(), which bash reads completely before starting. That matters
# because pulling an update may replace this very file while it runs.
main() {
  set -euo pipefail
  local repo_url="${REPO_URL:-https://github.com/twwety2050/Game.git}"
  local branch="${BRANCH:-claude/minecraft-clone-3mer7c}"
  local interval="${INTERVAL:-30}"
  local here default_dir
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [ -d "$here/.git" ]; then default_dir="$here"; else default_dir="$HOME/VoxelCraft"; fi
  local dir="${1:-$default_dir}"
  local port="${2:-8000}"

  command -v git >/dev/null || { echo "Git isn't installed: https://git-scm.com/downloads"; exit 1; }
  local py=""
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null && "$candidate" --version 2>&1 | grep -q "Python 3"; then py="$candidate"; break; fi
  done
  [ -n "$py" ] || { echo "Python 3 isn't installed: https://www.python.org/downloads/"; exit 1; }

  if [ ! -d "$dir/.git" ]; then
    echo "Downloading the game into $dir ..."
    git clone --branch "$branch" "$repo_url" "$dir"
  fi
  cd "$dir"
  git checkout -q "$branch"

  "$py" tools/serve.py --port "$port" &
  local server=$!
  trap 'kill "$server" 2>/dev/null; exit 0' INT TERM
  trap 'kill "$server" 2>/dev/null' EXIT
  sleep 2
  kill -0 "$server" 2>/dev/null || { echo "The web server didn't start (see the message above)."; exit 1; }
  echo "Checking GitHub for updates every ${interval}s."

  while true; do
    if git fetch -q origin "$branch" 2>/dev/null; then
      if [ "$(git rev-parse HEAD)" != "$(git rev-parse FETCH_HEAD)" ]; then
        if git merge -q --ff-only FETCH_HEAD 2>/dev/null; then
          echo "[$(date +%H:%M:%S)] Updated to: $(git log -1 --format='%h %s'). Refresh your browser."
        else
          echo "[$(date +%H:%M:%S)] An update is available but your local changes are in the way."
          echo "    To throw your changes away and update: cd \"$dir\" && git reset --hard FETCH_HEAD"
        fi
      fi
    else
      echo "[$(date +%H:%M:%S)] Couldn't reach GitHub; will try again."
    fi
    sleep "$interval"
    kill -0 "$server" 2>/dev/null || { echo "The web server stopped."; exit 1; }
  done
}

main "$@"
exit
