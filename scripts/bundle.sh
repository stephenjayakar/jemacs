#!/usr/bin/env bash
# Build dist/jemacs-$REV.tar.gz — the self-install payload that
# `shadow-connect ssh://host` ships to ~/.jemacs/bin/jemacs-$REV/ on the
# remote (DESIGN.md §Self-install). $REV pins client and server to the same
# protocol so a mismatch is impossible.
#
#   scripts/bundle.sh            # writes dist/jemacs-$(git rev-parse --short HEAD).tar.gz
#   JEMACS_REV=foo scripts/bundle.sh
#
# The tarball is source + a `jemacs` launcher stub; `bun build --compile`
# (single static binary) replaces this once it's wired up.
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$DIR")
REV=${JEMACS_REV:-$(git -C "$ROOT" rev-parse --short HEAD)}
OUT="$ROOT/dist/jemacs-$REV.tar.gz"

mkdir -p "$ROOT/dist"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# Launcher the remote execs as ~/.jemacs/bin/jemacs-$REV/jemacs.
# JEMACS_REV is baked in so the server reports the same rev without git.
cat >"$STAGE/jemacs" <<EOF
#!/usr/bin/env bash
set -euo pipefail
HERE=\$(cd "\$(dirname "\$0")" && pwd)
BUN=\$(command -v bun || printf '%s\n' "\$HOME/.bun/bin/bun")
export JEMACS_REV='$REV'
exec "\$BUN" run "\$HERE/src/main.ts" "\$@"
EOF
chmod +x "$STAGE/jemacs"

# Source tree + runtime deps. Tests, journals, native electron bits stay behind.
tar czf "$OUT" \
  -C "$STAGE" jemacs \
  -C "$ROOT" \
  --exclude='*.test.ts' \
  --exclude='do_not_commit' \
  --exclude='journals' \
  --exclude='node_modules/electron' \
  --exclude='node_modules/.cache' \
  src lisp plugins package.json tsconfig.json node_modules

printf '%s\n' "$OUT"
