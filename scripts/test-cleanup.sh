#!/bin/sh
# Kill any leaked jemacs tui-probe sessions and their editors.
# Only marked test spawns are killed, so an interactive editor survives.
DIR=$(dirname "$0")
tmux ls 2>/dev/null | grep -E '^(jt|jx|jv|qa|jterm)' | cut -d: -f1 | xargs -rn1 tmux kill-session -t 2>/dev/null
"$DIR/reap-strays.sh" kill
