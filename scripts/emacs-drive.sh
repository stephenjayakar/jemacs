#!/usr/bin/env bash
# Drive Emacs in a headless tmux pane (Stephen's config) for parity checks.
#
#   scripts/emacs-drive.sh start [file]       # 120×35, emacs -nw
#   scripts/emacs-drive.sh keys C-x C-f ... Enter
#   scripts/emacs-drive.sh cap                # plain-text screen
#   scripts/emacs-drive.sh echo               # last echo-area line
#   scripts/emacs-drive.sh modeline           # mode line (second-from-last row)
#   scripts/emacs-drive.sh wait 'regex' [secs]
#   scripts/emacs-drive.sh stop
#
# Environment:
#   EMACS_DRIVE_SESSION   tmux session name (default: jemacs-emacs)
#   EMACS_INIT            init file (default: ~/.emacs.d/init.el)
set -euo pipefail
S=${EMACS_DRIVE_SESSION:-jemacs-emacs}
INIT=${EMACS_INIT:-${HOME}/.emacs.d/init.el}

case "${1:-}" in
  start)
    tmux kill-session -t "$S" 2>/dev/null || true
    shift
    tmux new-session -d -s "$S" -x 120 -y 35 \
      "emacs -nw -l ${INIT} $*"
    for _ in $(seq 120); do
      # Do not accept the transient *scratch* (Fundamental) frame: with a
      # nontrivial init file it appears before the requested file and mode
      # have loaded, causing parity keys to be sent to the wrong buffer.
      tmux capture-pane -t "$S" -p 2>/dev/null | grep -qE '\(Markdown|TypeScript|typescript|\.ts|\.md|line [0-9]+' && exit 0
      sleep 0.1
    done
    echo "emacs did not draw within 12s" >&2; exit 1 ;;
  keys)
    shift
    for k in "$@"; do
      if [[ "$k" =~ ^(C-|M-|S-|C-M-|Escape$|Enter$|Space$|Tab$|BSpace$|Up$|Down$|Left$|Right$|Home$|End$|PgUp$|PgDn$|F[0-9]+$) ]]; then
        tmux send-keys -t "$S" -- "${k//;/\\;}"
      else
        tmux send-keys -t "$S" -l -- "${k/%;/\\;}"
      fi
      sleep 0.03
    done
    sleep 0.15 ;;
  cap)      tmux capture-pane -t "$S" -p ;;
  echo)
    tmux capture-pane -t "$S" -p | grep -v '^$' | tail -n 1 ;;
  modeline) tmux capture-pane -t "$S" -p | grep -v '^$' | tail -n 2 | head -n 1 ;;
  wait)
    re=${2:?regex}; secs=${3:-8}
    for _ in $(seq "$((secs*10))"); do
      tmux capture-pane -t "$S" -p | grep -qE "$re" && exit 0
      sleep 0.1
    done
    exit 1 ;;
  stop) tmux kill-session -t "$S" 2>/dev/null || true ;;
  *) sed -n '2,14p' "$0"; exit 2 ;;
esac
