#!/usr/bin/env bash
# Drive jemacs in a headless tmux pane: send keystrokes, capture rendered text.
#
#   scripts/tui-drive.sh start [args...]       # spawn 120x35 pane
#   scripts/tui-drive.sh keys C-x C-f foo Enter
#   scripts/tui-drive.sh cap                   # plain-text screen → stdout
#   scripts/tui-drive.sh capansi               # with SGR escapes (colour)
#   scripts/tui-drive.sh modeline              # last non-echo line
#   scripts/tui-drive.sh wait 'regex' [secs]   # poll cap until regex matches
#   scripts/tui-drive.sh stop                  # kill-session, then TERM/KILL the pane
#
# Set JEMACS_TEST_RUN_ID to tag the spawn for scripts/reap-strays.sh.
# Keys use tmux key syntax: C-x M-x Escape Enter Space Tab BSpace Up/Down etc.
# Literal text: pass as one arg ("hello world" → typed verbatim).
set -euo pipefail
DIR=$(dirname "$0")
BUN=$("$DIR/bun-cmd.sh")
S=${JEMACS_TMUX_SESSION:-jemacs}
MARKER=${JEMACS_TEST_MARKER:-jemacs-test-spawn}
REAP="$DIR/reap-strays.sh"

# tmux kill-session only sends SIGHUP, which bun routinely survives, leaving it
# reparented to launchd forever. Snapshot the pane pids *before* killing the
# session — afterwards the pane is gone and there is nothing left to walk — then
# escalate TERM -> KILL over the whole tree.
stop_session() {
  local panes
  panes=$(tmux list-panes -t "$S" -F '#{pane_pid}' 2>/dev/null || true)
  tmux kill-session -t "$S" 2>/dev/null || true
  # shellcheck disable=SC2086
  [ -n "${panes// /}" ] && "$REAP" kill-pids $panes
  return 0
}

case "${1:-}" in
  start)
    stop_session
    shift
    EMPTY_CFG="$DIR/../test/fixtures/empty-config.ts"
    # Tag test spawns on the *command line*: macOS `ps -E` cannot show the
    # environment, so an env-only marker would not be greppable by the sweeps.
    # parseStartupArgs() ignores unknown `--flags`, so this is inert to jemacs.
    MARK=""
    if [ -n "${JEMACS_TEST_RUN_ID:-}" ]; then
      MARK="--jemacs-test-marker=$MARKER:$JEMACS_TEST_RUN_ID"
    fi
    tmux new-session -d -s "$S" -x 120 -y 35 \
      "export TERM=\${TERM:-screen-256color}; export JEMACS_INIT_PATH='$EMPTY_CFG'; export JEMACS_TEST_RUN_ID='${JEMACS_TEST_RUN_ID:-}'; cd $DIR/.. && exec $BUN run src/main.ts $MARK $*"
    for _ in $(seq 120); do
      tmux capture-pane -t "$S" -p 2>/dev/null | grep -qE 'Jemacs OpenTUI|markdown|gfm|line [0-9]+, col' && exit 0
      sleep 0.1
    done
    echo "jemacs did not draw within 12s" >&2; exit 1 ;;
  keys)
    shift
    for k in "$@"; do
      # tmux key names are single tokens; anything else is literal text
      # tmux treats a trailing ';' on an arg as a command separator (-- doesn't help),
      # so M-; would arrive as 'M-' and a bare ';' key would vanish.
      if [[ "$k" =~ ^(C-|M-|S-|C-M-|Escape$|Enter$|Space$|Tab$|BSpace$|Up$|Down$|Left$|Right$|Home$|End$|PgUp$|PgDn$|F[0-9]+$) ]]; then
        tmux send-keys -t "$S" -- "${k//;/\\;}"
      else
        tmux send-keys -t "$S" -l -- "${k/%;/\\;}"
      fi
      sleep 0.03
    done
    sleep 0.12 ;;
  cap)      tmux capture-pane -t "$S" -p ;;
  capansi)  tmux capture-pane -t "$S" -p -e ;;
  modeline) tmux capture-pane -t "$S" -p | grep -v '^$' | tail -n 2 | head -n 1 ;;
  wait)
    re=${2:?regex}; secs=${3:-5}
    for _ in $(seq "$((secs*10))"); do
      tmux capture-pane -t "$S" -p | grep -qE "$re" && exit 0
      sleep 0.1
    done
    exit 1 ;;
  stop) stop_session ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
