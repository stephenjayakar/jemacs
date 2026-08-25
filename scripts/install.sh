#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
JEMACS_HOME="${JEMACS_HOME:-${DATA_HOME}/jemacs}"

if [ -d "${HOME}/bin" ]; then
  BIN_DIR="${BIN_DIR:-${HOME}/bin}"
else
  BIN_DIR="${BIN_DIR:-${HOME}/.local/bin}"
fi

run_bun() {
  if command -v bun >/dev/null 2>&1; then
    bun "$@"
  else
    npx bun "$@"
  fi
}

install_link() {
  local source="$1"
  local destination="$2"
  if [[ -e "${destination}" && ! -L "${destination}" ]]; then
    if [[ "$(cd "${destination}" 2>/dev/null && pwd -P)" == "$(cd "${source}" && pwd -P)" ]]; then
      return
    fi
    echo "jemacs: refusing to replace ${destination}; move it or set JEMACS_HOME" >&2
    exit 1
  fi
  ln -sfn "${source}" "${destination}"
}

cd "${SOURCE_DIR}"
run_bun install
run_bun run check || echo "warn: typecheck reported errors"
if [[ "${JEMACS_INSTALL_SKIP_TEST:-}" != "1" && "${JEMACS_CORE_INSTALL_SKIP_TEST:-}" != "1" ]]; then
  run_bun test || echo "warn: some tests failed (set JEMACS_INSTALL_SKIP_TEST=1 to skip)"
fi
if [[ "${JEMACS_INSTALL_SKIP_GUI:-}" != "1" ]]; then
  run_bun run build:gui || echo "warn: GUI build failed (set JEMACS_INSTALL_SKIP_GUI=1 to skip)"
fi

mkdir -p "$(dirname "${JEMACS_HOME}")" "${BIN_DIR}"
install_link "${SOURCE_DIR}" "${JEMACS_HOME}"
chmod +x "${SOURCE_DIR}/scripts/jemacs"
install_link "${SOURCE_DIR}/scripts/jemacs" "${BIN_DIR}/jemacs"

echo "Installed Jemacs core:"
echo "  core     ${JEMACS_HOME} -> ${SOURCE_DIR}"
echo "  launcher ${BIN_DIR}/jemacs"
