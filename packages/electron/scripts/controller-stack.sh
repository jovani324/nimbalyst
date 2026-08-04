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
#   bash controller-stack.sh start [relay|host|controller]
#   bash controller-stack.sh stop [relay|host|controller] [--force]
#   bash controller-stack.sh status
#   bash controller-stack.sh logs
#
# GOLDEN RULE: quit the normal Nimbalyst app before `start` — the fork HOST uses
# the same default data folder and the DB lock is exclusive. Back up first.
#
# Env overrides:
#   RELAY_DIR       path to private-sync-relay (default: ../../../private-sync-relay
#                   relative to this script, i.e. a sibling of the fork checkout)
#   SYNC_URL        sync server (default: ws://localhost:8790)
#   GRACE_SECONDS   how long to wait for a graceful quit before escalating (default: 15)
#   CONTROLLER_LOG_DIR  where logs/pidfiles live (default: packages/electron/.controller-logs)
#   ALLOW_HEADLESS_START  set to 1 to start over SSH anyway (sync will NOT work:
#                   no GUI session means no Keychain, so both instances come up
#                   signed out). Start from the machine's desktop session instead.
set -euo pipefail

# ── Resolve paths ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"          # packages/electron
FORK_ROOT="$(cd "$ELECTRON_DIR/../.." && pwd)"        # repo root
RELAY_DIR="${RELAY_DIR:-$(cd "$FORK_ROOT/.." && pwd)/private-sync-relay}"
SYNC_URL="${SYNC_URL:-ws://localhost:8790}"
GRACE_SECONDS="${GRACE_SECONDS:-15}"

# Port the relay listens on, parsed off SYNC_URL. Used to spot a relay that
# outlived its pidfile — the port is the only honest evidence it is still up.
RELAY_PORT="$(printf '%s' "$SYNC_URL" | sed -n 's#.*:\([0-9][0-9]*\)$#\1#p')"
RELAY_PORT="${RELAY_PORT:-8790}"

# Overridable so a test run cannot clobber the pidfiles of a live stack.
LOG_DIR="${CONTROLLER_LOG_DIR:-$ELECTRON_DIR/.controller-logs}"
PID_DIR="$LOG_DIR/pids"
mkdir -p "$PID_DIR"

SERVICES="relay host controller"
FORCE=0

pidfile() { echo "$PID_DIR/$1.pid"; }

is_running() {
  local f; f="$(pidfile "$1")"
  [ -f "$f" ] || return 1
  local pid; pid="$(cat "$f" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

# ── Process-group plumbing ────────────────────────────────────────────────────
# Each service is started as its own process-group LEADER, and `set -m` is what
# makes that happen. Without job control a background job inherits the script's
# process group, so `kill -TERM -$pid` names a group that does not exist: the
# kill fails, the `||` fallback reaps only the wrapper, and the real tree
# (npm -> electron-vite -> Electron) is orphaned while the pidfile is deleted.
# That combination is what made `stop` silently leave both apps running and then
# report everything stopped.
#
# The `( ... ) &` grouping also matters: `&` binds looser than `&&`, so the old
# `cd "$dir" && nohup "$@" &` backgrounded the whole AND-list as an anonymous
# subshell and recorded *that* in the pidfile rather than the service itself.
# Parenthesising is explicit, and `exec` keeps the subshell's pid, so the
# recorded pid is both the service and its group leader.
start_one() {
  local name="$1"; shift
  local dir="$1"; shift
  if is_running "$name"; then
    echo "  $name already running (pid $(cat "$(pidfile "$name")"))"
    return 0
  fi
  local pid
  set -m
  ( cd "$dir" && exec nohup "$@" >"$LOG_DIR/$name.log" 2>&1 ) &
  pid=$!
  set +m
  echo "$pid" >"$(pidfile "$name")"
  echo "  started $name (pid/pgid $pid) -> $LOG_DIR/$name.log"
}

# Signal a whole process group, falling back to the bare pid if the group is
# gone. Never let a failed kill abort the script (set -e).
signal_group() {
  local sig="$1" pid="$2"
  kill "-$sig" "-$pid" 2>/dev/null || kill "-$sig" "$pid" 2>/dev/null || true
}

# Wait for a pid to disappear. Returns 0 if it died within the grace period.
await_exit() {
  local pid="$1" waited=0
  while [ "$waited" -lt "$GRACE_SECONDS" ]; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
    waited=$((waited + 1))
  done
  ! kill -0 "$pid" 2>/dev/null
}

# Returns 0 only when the service is CONFIRMED gone. The pidfile is removed on
# that confirmation and kept otherwise — a stale-but-truthful pidfile is what
# lets `status` report a survivor instead of claiming a clean stop.
stop_one() {
  local name="$1"
  local f; f="$(pidfile "$name")"
  local pid=""
  [ -f "$f" ] && pid="$(cat "$f" 2>/dev/null || true)"

  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    echo "  $name not running"
    rm -f "$f"
    return 0
  fi

  signal_group TERM "$pid"

  # Electron gets the full grace period on purpose: a hard kill skips the
  # database backup/shutdown path and can corrupt the profile, so SIGKILL is
  # opt-in for host/controller. The relay holds no database, so escalating on
  # it is always safe.
  if await_exit "$pid"; then
    echo "  stopped $name"
    rm -f "$f"
    return 0
  fi

  if [ "$FORCE" = "1" ] || [ "$name" = "relay" ]; then
    signal_group KILL "$pid"
    sleep 1
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "  stopped $name (SIGKILL)"
      rm -f "$f"
      return 0
    fi
  fi

  echo "  ! $name did NOT stop (pid $pid alive after ${GRACE_SECONDS}s)" >&2
  if [ "$name" != "relay" ] && [ "$FORCE" != "1" ]; then
    echo "    it may still be flushing its database; re-run, or 'stop $name --force'" >&2
  fi
  return 1
}

# ── Leftover detection ────────────────────────────────────────────────────────
# Processes belonging to THIS checkout whose process group we do not currently
# manage — i.e. survivors of an earlier broken stop. Matching is scoped to
# $FORK_ROOT so a normal /Applications/Nimbalyst.app is never a candidate.
unmanaged_pids() {
  local managed=" " n p pg
  for n in $SERVICES; do
    if is_running "$n"; then managed="$managed$(cat "$(pidfile "$n")") "; fi
  done
  for p in $(pgrep -f "$FORK_ROOT/node_modules/(electron/dist|\.bin/electron-vite)" 2>/dev/null || true); do
    pg="$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')"
    [ -n "$pg" ] || continue
    case "$managed" in *" $pg "*) continue ;; esac
    echo "$p"
  done
}

# The relay is a bare `node server.mjs`, so identify it by who holds the port
# and confirm the command before claiming it. Skipped when it is the relay we
# already manage.
unmanaged_relay_pid() {
  local p pg managed=""
  p="$(lsof -nP -iTCP:"$RELAY_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  [ -n "$p" ] || return 0
  ps -o command= -p "$p" 2>/dev/null | grep -q 'server\.mjs' || return 0
  if is_running relay; then managed="$(cat "$(pidfile relay)")"; fi
  pg="$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')"
  [ -n "$managed" ] && [ "$pg" = "$managed" ] && return 0
  echo "$p"
}

# Scoped to $TARGETS: `stop relay` must never sweep the host/controller, or a
# narrow command (and any test that drives one) would reap an unrelated
# `npm run dev` started outside the stack.
leftover_pids() {
  {
    case " $TARGETS " in *" host "*|*" controller "*) unmanaged_pids ;; esac
    case " $TARGETS " in *" relay "*) unmanaged_relay_pid ;; esac
  } | grep -v '^$' | sort -u || true
}

sweep_leftovers() {
  local pids p
  pids="$(leftover_pids)"
  [ -n "$pids" ] || return 0
  echo "  sweeping leftovers from an earlier stop: $(echo "$pids" | tr '\n' ' ')"
  for p in $pids; do signal_group TERM "$p"; done
  for p in $pids; do
    if ! await_exit "$p" && [ "$FORCE" = "1" ]; then signal_group KILL "$p"; fi
  done
  pids="$(leftover_pids)"
  if [ -n "$pids" ]; then
    echo "  ! leftovers still alive: $(echo "$pids" | tr '\n' ' ')" >&2
    [ "$FORCE" = "1" ] || echo "    re-run with --force to SIGKILL them" >&2
    return 1
  fi
  return 0
}

port_line() {
  local port="$1" label="$2" owner
  owner="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [ -n "$owner" ]; then
    echo "    $port ($label): held by pid $owner"
  else
    echo "    $port ($label): free"
  fi
}

# ── Argument parsing ──────────────────────────────────────────────────────────
CMD="${1:-start}"
shift || true
TARGETS="$SERVICES"
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    relay|host|controller) TARGETS="$arg" ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

case "$CMD" in
  start)
    echo "Controller stack — starting (sync: $SYNC_URL)"
    # Electron started over SSH has no GUI session, so macOS denies Keychain
    # access (errKCInteractionNotAllowed). safeStorage then cannot decrypt the
    # Stytch credentials, StytchAuthService falls through to parsing the raw
    # os_crypt blob as JSON, and BOTH instances come up silently signed out --
    # no sync provider, no remote sessions. Nothing in the UI explains why, so
    # refuse up front rather than hand back a stack that looks started.
    if [ -n "${SSH_CONNECTION:-}" ] && [ "${ALLOW_HEADLESS_START:-0}" != "1" ]; then
      echo "  ! refusing to start over SSH: Electron would have no Keychain access and" >&2
      echo "    would come up signed out (errKCInteractionNotAllowed)." >&2
      echo "    Start it from a terminal in this machine's own desktop session." >&2
      echo "    Set ALLOW_HEADLESS_START=1 to override (sync will not work)." >&2
      exit 1
    fi
    if [ ! -d "$RELAY_DIR" ]; then
      echo "  ! relay not found at $RELAY_DIR — set RELAY_DIR=/path/to/private-sync-relay" >&2
      exit 1
    fi
    if [ ! -d "$RELAY_DIR/node_modules" ]; then
      echo "  relay deps missing — running npm install in $RELAY_DIR"
      ( cd "$RELAY_DIR" && npm install >/dev/null 2>&1 )
    fi
    # A leftover relay holds port 8790, so a fresh one dies on EADDRINUSE and
    # the stack silently keeps using the stale process. Say so rather than
    # starting on top of it.
    leftovers="$(leftover_pids)"
    if [ -n "$leftovers" ]; then
      echo "  ! processes from a previous run are still alive: $(echo "$leftovers" | tr '\n' ' ')" >&2
      echo "    run 'bash controller-stack.sh stop' first (add --force if it refuses)" >&2
      exit 1
    fi
    echo "  reminder: the normal Nimbalyst app must be QUIT (shared DB lock)."
    case " $TARGETS " in *" relay "*) start_one relay "$RELAY_DIR" node server.mjs; sleep 1 ;; esac
    case " $TARGETS " in *" host "*) start_one host "$ELECTRON_DIR" env NIMBALYST_SYNC_URL="$SYNC_URL" npm run dev ;; esac
    case " $TARGETS " in *" controller "*) start_one controller "$ELECTRON_DIR" env NIMBALYST_SYNC_URL="$SYNC_URL" npm run dev:user2 ;; esac
    echo "Done. Alt+Space toggles the controller popover. 'bash controller-stack.sh logs' to watch."
    ;;
  stop)
    echo "Controller stack — stopping"
    rc=0
    for n in controller host relay; do
      case " $TARGETS " in *" $n "*) stop_one "$n" || rc=1 ;; esac
    done
    sweep_leftovers || rc=1
    exit "$rc"
    ;;
  status)
    for n in $SERVICES; do
      if is_running "$n"; then echo "  $n: running (pid $(cat "$(pidfile "$n")"))"; else echo "  $n: stopped"; fi
    done
    echo "  ports:"
    port_line "$RELAY_PORT" relay
    port_line 5273 "host vite"
    port_line 5274 "controller vite"
    leftovers="$(leftover_pids)"
    if [ -n "$leftovers" ]; then
      echo "  ! unmanaged processes from this checkout (survived an earlier stop):"
      for p in $leftovers; do
        echo "    $(ps -o pid=,pgid=,command= -p "$p" 2>/dev/null | cut -c1-100)"
      done
      echo "    clear them with 'bash controller-stack.sh stop'"
    fi
    ;;
  logs)
    echo "Tailing logs (Ctrl+C to stop)…"
    tail -n 20 -F "$LOG_DIR/relay.log" "$LOG_DIR/host.log" "$LOG_DIR/controller.log" 2>/dev/null
    ;;
  *)
    echo "usage: bash controller-stack.sh {start|stop|status|logs} [relay|host|controller] [--force]" >&2
    exit 1
    ;;
esac
