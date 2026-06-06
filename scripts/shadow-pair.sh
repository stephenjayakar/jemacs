#!/usr/bin/env bash
# Spawn an A↔S shadow pair side-by-side in tmux for hands-on testing of the
# stdio transport (DESIGN.md §Local play).
#
#   scripts/shadow-pair.sh [FILE]       # FILE defaults to a fresh temp scratch
#   scripts/shadow-pair.sh stop         # tear down the tmux session
#
# Layout (tmux session $JEMACS_PAIR_SESSION, default "jemacs-pair"):
#
#   ┌──────────────── left ───────────────┬─────────────── right ───────────────┐
#   │ bun run src/main.ts FILE            │ bun run src/main.ts                 │
#   │                                     │   M-x shadow-connect                │
#   │ A reference jemacs on FILE. NOT the │   stdio:"bun ... --serve-stdio FILE"│
#   │ authority — just a viewer of disk   │                                     │
#   │ state. M-x revert-buffer to reread  │ S, the shadow client. shadow-connect│
#   │ after the authority saves (the      │ spawns the authority A as a child   │
#   │ authority is a UI-less subprocess   │ process. Type here; modeline shows  │
#   │ of the right pane).                 │ [⇅ N] pending → [✓] when A acks.    │
#   └─────────────────────────────────────┴─────────────────────────────────────┘
#
# Inspecting A's in-memory buffer (no UI of its own):
#   scripts/shadow-pair.sh dump          # SIGUSR1 → cat /tmp/jemacs-dump-<pid>
#
# This is the StdioLink path; once WsLink lands the left pane can BE the
# authority and you'll see it converge live without revert/dump.
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$DIR")
BUN=$("$DIR/bun-cmd.sh")
S=${JEMACS_PAIR_SESSION:-jemacs-pair}
CFG="$ROOT/test/fixtures/empty-config.ts"

case "${1:-}" in
  stop)
    tmux kill-session -t "$S" 2>/dev/null || true
    # A is a grandchild of the tmux pane; SIGHUP to S doesn't always reach it.
    pkill -f 'src/main\.ts --serve-stdio' 2>/dev/null || true
    exit 0 ;;
  dump)
    pid=$(pgrep -nf 'src/main\.ts --serve-stdio' || true)
    [[ -n "$pid" ]] || { echo "no --serve-stdio authority running" >&2; exit 1; }
    kill -USR1 "$pid"; sleep 0.1
    cat "/tmp/jemacs-dump-$pid"
    exit 0 ;;
esac

FILE=${1:-$(mktemp /tmp/jemacs-pair-XXXXXX.txt)}
touch "$FILE"
TARGET="stdio:$BUN run src/main.ts --serve-stdio --config $CFG $FILE"

tmux kill-session -t "$S" 2>/dev/null || true
# -P -F prints the new pane's id (%N) so we don't depend on base-index/pane-base-index.
LEFT=$(tmux new-session -d -s "$S" -x 240 -y 40 -P -F '#{pane_id}' \
  "export JEMACS_INIT_PATH='$CFG'; cd '$ROOT' && exec $BUN run src/main.ts '$FILE'")
RIGHT=$(tmux split-window -h -t "$LEFT" -P -F '#{pane_id}' \
  "export JEMACS_INIT_PATH='$CFG'; cd '$ROOT' && exec $BUN run src/main.ts")

# Wait for the right pane to draw, then drive M-x shadow-connect TARGET and
# switch to the announced buffer so the user can start typing immediately.
for _ in $(seq 120); do
  tmux capture-pane -t "$RIGHT" -p 2>/dev/null | grep -qE 'line [0-9]+, col' && break
  sleep 0.1
done
tmux send-keys -t "$RIGHT" -- M-x; sleep 0.05
tmux send-keys -t "$RIGHT" -l -- "shadow-connect"; tmux send-keys -t "$RIGHT" -- Enter; sleep 0.1
tmux send-keys -t "$RIGHT" -l -- "$TARGET"; tmux send-keys -t "$RIGHT" -- Enter
for _ in $(seq 100); do
  tmux capture-pane -t "$RIGHT" -p | grep -q 'shadow.*connected' && break
  sleep 0.1
done
# C-x b's collection is snapshotted at prompt time, so wait for A to finish
# booting and announce the file buffer before switching to it.
BASE=$(basename "$FILE")
for _ in $(seq 50); do
  tmux send-keys -t "$RIGHT" -- C-x b; sleep 0.1
  if tmux capture-pane -t "$RIGHT" -p | grep -qE "^(  |► )/.*${BASE}"; then
    tmux send-keys -t "$RIGHT" -l -- "$BASE"; tmux send-keys -t "$RIGHT" -- Enter
    break
  fi
  tmux send-keys -t "$RIGHT" -- C-g; sleep 0.2
done
tmux select-pane -t "$RIGHT"

echo "shadow pair on '$FILE' — attaching (right pane is S; type there)."
echo "  scripts/shadow-pair.sh dump   → print A's buffer"
echo "  scripts/shadow-pair.sh stop   → tear down"
exec tmux attach -t "$S"
