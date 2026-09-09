#!/usr/bin/env bash
# Pre-dev cleanup: kill stale/orphan processes left by a previous `pnpm dev`
# so a fresh start can never render against a dead or outdated dev server.
#
# Background (2026-09 white-screen incidents): an orphaned vite kept port
# 5173 alive after its stack died; the next `pnpm dev` silently drifted to
# :5174 while Electron still loaded :5173, rendering a stale/broken bundle
# (permanent white screen). A leftover tsup watcher from days earlier also
# raced the live one on the same electron/dist output. This script runs
# before `pnpm dev` and clears:
#   1. anything listening on the dev-server port (usually an orphan vite)
#   2. leftover vite / tsup / concurrently / cross-env / electron dev
#      processes whose command line points into THIS project directory
#
# The packaged /Applications/Harnss.app never matches these patterns, and
# other checkouts live under different paths, so they are untouched.
set -uo pipefail
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd -P)"
PORT="${VITE_PORT:-5173}"

# 1. Free the dev-server port.
port_pids="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$port_pids" ]]; then
  echo "[clean-dev-env] freeing :$PORT (pids: $(echo "$port_pids" | tr '\n' ' '))"
  kill $port_pids 2>/dev/null || true
fi

# 2. Kill stale dev processes rooted in this project (pnpm's .pnpm store
#    paths are unique to this checkout; dev-only tools never appear in the
#    packaged app). Note pnpm binaries resolve as
#    node_modules/.bin/../.pnpm/<name>@<ver>/..., so anchor on ".pnpm/<name>@"
#    rather than "node_modules/.pnpm/".
orphan_pids="$(ps -eo pid=,command= | awk -v dir="$PROJECT_DIR" '
  index($0, dir) > 0 && \
  ($0 ~ /\.pnpm\/(vite|tsup|concurrently|cross-env)@[0-9]/ || \
   $0 ~ /\.pnpm\/electron@[0-9]/) \
  { print $1 }
' | grep -vw "$$" || true)"
if [[ -n "$orphan_pids" ]]; then
  echo "[clean-dev-env] killing stale dev processes:"
  echo "$orphan_pids" | while read -r p; do
    ps -o command= -p "$p" 2>/dev/null | cut -c1-100 | sed 's/^/  /'
  done
  kill $orphan_pids 2>/dev/null || true
fi

# 3. Wait briefly; force-kill whatever survived.
sleep 1
survivors="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$survivors" ]]; then
  echo "[clean-dev-env] force-killing port squatters: $(echo "$survivors" | tr '\n' ' ')"
  kill -9 $survivors 2>/dev/null || true
fi

echo "[clean-dev-env] clean (port $PORT free, no stale watchers)"
