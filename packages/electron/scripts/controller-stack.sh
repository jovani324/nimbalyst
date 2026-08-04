#!/usr/bin/env bash
#
# controller-stack.sh — one-shot launcher for the Controller Mode stack:
#   1) local sync relay        (ws://localhost:8790)
#   2) fork HOST               (npm run dev — default profile, your real data)
#   3) discreet CONTROLLER     (npm run dev:user2 — isolated profile, popover)
#
# Everything talks over localhost, so no network / Tailscale is needed. Run it
# from any shell (bash/zsh/nushell) as an external command — it sidesteps
# nushell's env-prefix quirk by exporting the sync URL itself.
#
# Usage:
#   bash controller-stack.sh start     # start all three (backgrounded, logs in ./.controller-logs)
#   bash controller-stack.sh stop      # stop all three
#   bash controller-stack.sh status    # show what's running
#   bash controller-stack.sh logs      # tail all three logs
#
# GOLDEN RULE: quit the normal Nimbalyst app before `start` — the fork HOST uses
# the same default data folder and the DB lock is exclusive. Back up first.
#
# Env overrides:
#   RELAY_DIR   path to private-sync-relay (default: ../../../private-sync-relay
#               relative to this script, i.e. a sibling of the fork checkout)
#   SYNC_URL    sync server (default: ws://localhost:8790)
set -euo pipefail

# ── Resolve paths ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"          # packages/electron
FORK_ROOT="$(cd "$ELECTRON_DIR/../.." && pwd)"        # repo root
RELAY_DIR="${RELAY_DIR:-$(cd "$FORK_ROOT/.." && pwd)/private-sync-relay}"
SYNC_URL="${SYNC_URL:-ws://localhost:8790}"

LOG_DIR="$ELECTRON_DIR/.controller-logs"
PID_DIR="$LOG_DIR/pids"
mkdir -p "$PID_DIR"

pidfile() { echo "$PID_DIR/$1.pid"; }

is_running() {
  local f; f="$(pidfile "$1")"
  [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null
}

start_one() {
  local name="$1"; shift
  local dir="$1"; shift
  if is_running "$name"; then
    echo "  $name already running (pid $(cat "$(pidfile "$name")"))"
    return
  fi
  ( cd "$dir" && nohup "$@" >"$LOG_DIR/$name.log" 2>&1 & echo $! >"$(pidfile "$name")" )
  echo "  started $name (pid $(cat "$(pidfile "$name")")) -> $LOG_DIR/$name.log"
}

stop_one() {
  local name="$1"; local f; f="$(pidfile "$name")"
  if is_running "$name"; then
    # kill the whole process group so electron-vite children die too
    kill -TERM "-$(cat "$f")" 2>/dev/null || kill -TERM "$(cat "$f")" 2>/dev/null || true
    echo "  stopped $name"
  else
    echo "  $name not running"
  fi
  rm -f "$f"
}

case "${1:-start}" in
  start)
    echo "Controller stack — starting (sync: $SYNC_URL)"
    if [ ! -d "$RELAY_DIR" ]; then
      echo "  ! relay not found at $RELAY_DIR — set RELAY_DIR=/path/to/private-sync-relay" >&2
      exit 1
    fi
    if [ ! -d "$RELAY_DIR/node_modules" ]; then
      echo "  relay deps missing — running npm install in $RELAY_DIR"
      ( cd "$RELAY_DIR" && npm install >/dev/null 2>&1 )
    fi
    echo "  reminder: the normal Nimbalyst app must be QUIT (shared DB lock)."
    start_one relay      "$RELAY_DIR"    node server.mjs
    sleep 1
    start_one host       "$ELECTRON_DIR" env NIMBALYST_SYNC_URL="$SYNC_URL" npm run dev
    start_one controller "$ELECTRON_DIR" env NIMBALYST_SYNC_URL="$SYNC_URL" npm run dev:user2
    echo "Done. Alt+Space toggles the controller popover. 'bash controller-stack.sh logs' to watch."
    ;;
  stop)
    echo "Controller stack — stopping"
    stop_one controller
    stop_one host
    stop_one relay
    ;;
  status)
    for n in relay host controller; do
      if is_running "$n"; then echo "  $n: running (pid $(cat "$(pidfile "$n")"))"; else echo "  $n: stopped"; fi
    done
    ;;
  logs)
    echo "Tailing logs (Ctrl+C to stop)…"
    tail -n 20 -F "$LOG_DIR/relay.log" "$LOG_DIR/host.log" "$LOG_DIR/controller.log" 2>/dev/null
    ;;
  *)
    echo "usage: bash controller-stack.sh {start|stop|status|logs}" >&2
    exit 1
    ;;
esac
