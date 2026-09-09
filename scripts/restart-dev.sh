#!/usr/bin/env bash
# Agent-safe self-restart for the Harnss dev instance.
#
# Why this exists: an agent running INSIDE the Harnss app once restarted the
# app with `kill -TERM <pids>...; nohup pnpm dev &`. The kill hit the app's own
# process tree first, so the shell running the command died before `pnpm dev`
# ever started, leaving the app (and its Telegram bot) dead until manually
# restarted (see logs/main-1787899767976.log, 2026-08-29).
#
# The fix inverts the order: this script FIRST re-execs itself into a fresh
# session with stdio redirected to the log (setsid equivalent on macOS, via
# python3), and only THEN kills the old PIDs and boots `pnpm dev`. Killing the
# old app can therefore never kill the restart.
#
# Usage:
#   bash scripts/restart-dev.sh [oldPid ...]
#   pnpm restart:dev [oldPid ...]
#
# Env:
#   HARNSS_RESTART_LOG    combined output log (default /tmp/harnss-dev-restart.log)
#   HARNSS_RESTART_DELAY  seconds to wait after killing old PIDs (default 3)

set -euo pipefail

LOG="${HARNSS_RESTART_LOG:-/tmp/harnss-dev-restart.log}"
DELAY="${HARNSS_RESTART_DELAY:-3}"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

if [[ "${HARNSS_RESTART_DETACHED:-0}" != "1" ]]; then
  # Phase 1: detach. Re-exec in a brand-new session with all stdio on LOG so a
  # dying pty (the old app being killed) cannot take us down with it.
  exec python3 - "$SCRIPT_PATH" "$@" <<'PYEOF'
import os
import sys

script = sys.argv[1]
args = sys.argv[2:]
log = os.environ.get("HARNSS_RESTART_LOG", "/tmp/harnss-dev-restart.log")
try:
    os.setsid()
except PermissionError:
    pass  # already a session leader; good enough
fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(fd, 0)
os.dup2(fd, 1)
os.dup2(fd, 2)
if fd > 2:
    os.close(fd)
env = dict(os.environ, HARNSS_RESTART_DETACHED="1")
os.execvpe("bash", ["bash", script, *args], env)
PYEOF
fi

# Phase 2: detached. Safe to kill the old instance now.
cd "$(dirname "$SCRIPT_PATH")/.."

if [[ $# -gt 0 ]]; then
  echo "[restart-dev] $(date '+%F %T') killing old pids: $*"
  kill -TERM "$@" 2>/dev/null || true
  sleep "$DELAY"
fi

echo "[restart-dev] $(date '+%F %T') starting pnpm dev (log: $LOG)"
nohup pnpm dev >>"$LOG" 2>&1 &
echo "[restart-dev] $(date '+%F %T') pnpm dev started as pid $!"
