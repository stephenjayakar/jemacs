#!/usr/bin/env bash
# List / kill layer-3 test editors leaked by tui-drive.sh.
# See "Process hygiene" in AGENTS.md — tmux kill-session alone does not stop bun.
#
#   scripts/reap-strays.sh list            # marked spawns: pid, run-id, age
#   scripts/reap-strays.sh kill [run-id]   # kill all marked spawns, or one run's
#   scripts/reap-strays.sh stale           # kill spawns whose runner pid is gone
#   scripts/reap-strays.sh kill-pids <pid>… # TERM -> KILL a tree (tui-drive.sh stop)
#
# tui-drive.sh tags each spawn with `--jemacs-test-marker=<marker>:<run-id>` when
# JEMACS_TEST_RUN_ID is set, so only test spawns match: an interactive
# `bun run src/main.ts` carries no marker and is never touched.
set -uo pipefail
MARKER=${JEMACS_TEST_MARKER:-jemacs-test-spawn}
TAG="--jemacs-test-marker=$MARKER:"

# pid<TAB>run-id<TAB>etime for every tagged editor. The `src/main.ts` guard and
# the non-empty run-id skip this script's own `ps`/`awk` (whose argv carries the
# tag with nothing after it).
marked() {
  ps -eww -o pid=,etime=,command= 2>/dev/null | awk -v tag="$TAG" '
    /src\/main\.ts/ {
      i = index($0, tag); if (i == 0) next
      run = substr($0, i + length(tag)); sub(/[ \t].*/, "", run)
      if (run != "") print $1 "\t" run "\t" $2 }'
}

# Every pid in a process tree, children first.
descendants() {
  local p kid
  for p in "$@"; do
    for kid in $(pgrep -P "$p" 2>/dev/null); do descendants "$kid"; done
    printf '%s\n' "$p"
  done
}

# SIGTERM, brief grace, then SIGKILL. bun survives SIGHUP, and the OpenTUI host
# in raw mode ignores SIGTERM too, so the grace is short on purpose: it only
# exists for well-behaved children (LSP servers, term subprocesses).
kill_tree() {
  local pids alive pid
  pids=$(descendants "$@" | tr '\n' ' ')
  [ -n "${pids// /}" ] || return 0
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null
  for _ in $(seq 5); do
    alive=""
    for pid in $pids; do kill -0 "$pid" 2>/dev/null && alive="$alive $pid"; done
    [ -n "${alive// /}" ] || return 0
    sleep 0.1
    pids=$alive
  done
  # shellcheck disable=SC2086
  kill -KILL $pids 2>/dev/null
  return 0
}

reap() {
  local pids="$*"
  [ -n "${pids// /}" ] || return 0
  # shellcheck disable=SC2086
  kill_tree $pids
  echo "reaped: $pids" >&2
}

case "${1:-list}" in
  list)
    printf 'PID\tRUN\tAGE\n'
    marked ;;
  kill)
    want=${2:-}
    # shellcheck disable=SC2046
    reap $(marked | awk -F '\t' -v want="$want" 'want == "" || $2 == want { print $1 }') ;;
  stale)
    # A run-id is `<runner-pid>-<rand>`; if that pid is gone the run was
    # interrupted and its editors are strays. A concurrent suite stays untouched.
    # shellcheck disable=SC2046
    reap $(marked | while IFS=$'\t' read -r pid run _; do
      kill -0 "${run%%-*}" 2>/dev/null || printf '%s\n' "$pid"
    done) ;;
  kill-pids)
    shift
    # shellcheck disable=SC2086
    [ $# -gt 0 ] && kill_tree "$@"
    exit 0 ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
