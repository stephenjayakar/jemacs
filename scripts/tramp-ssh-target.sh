#!/usr/bin/env bash
# Reproducible password-authenticated SSH target for real TRAMP tests.
set -euo pipefail

DIR=$(cd "$(dirname "$0")/.." && pwd)
NAME=${JEMACS_TRAMP_SSH_CONTAINER:-jemacs-tramp-ssh}
IMAGE=${JEMACS_TRAMP_SSH_IMAGE:-jemacs-tramp-ssh-test}
VOLUME=${JEMACS_TRAMP_SSH_VOLUME:-jemacs-tramp-fs}
PORT=${JEMACS_TRAMP_SSH_PORT:-22222}
TARGET="/ssh:jemacs@127.0.0.1#${PORT}:/home/jemacs/workspace/hello.txt"

forget_host_key() {
  ssh-keygen -R "[127.0.0.1]:${PORT}" >/dev/null 2>&1 || true
}

start() {
  docker build -t "$IMAGE" "$DIR/test/fixtures/tramp-ssh"
  if docker container inspect "$NAME" >/dev/null 2>&1; then
    published=$(docker port "$NAME" 22/tcp 2>/dev/null || true)
    if [ "$published" != "127.0.0.1:${PORT}" ]; then
      close_master
      docker rm -f "$NAME" >/dev/null
      forget_host_key
    fi
  fi
  if docker container inspect "$NAME" >/dev/null 2>&1; then
    docker start "$NAME" >/dev/null
  else
    docker volume create "$VOLUME" >/dev/null
    docker run -d \
      --name "$NAME" \
      --restart unless-stopped \
      -p "127.0.0.1:${PORT}:22" \
      -v "$VOLUME:/home/jemacs" \
      "$IMAGE" >/dev/null
  fi

  for _ in $(seq 1 60); do
    if nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then
      printf 'TRAMP target: %s\nUser: jemacs\nPassword: tramp-test\n' "$TARGET"
      return
    fi
    sleep 0.25
  done
  docker logs "$NAME" >&2
  return 1
}

close_master() {
  ssh -O exit \
    -o "ControlPath=$HOME/.ssh/jemacs-%r@%h-%p" \
    -p "$PORT" -- jemacs@127.0.0.1 >/dev/null 2>&1 || true
}

case "${1:-start}" in
  start)
    start
    ;;
  stop)
    close_master
    docker stop "$NAME" >/dev/null 2>&1 || true
    ;;
  reset)
    close_master
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
    forget_host_key
    start
    ;;
  status)
    docker ps --filter "name=^/${NAME}$"
    printf 'TRAMP target: %s\n' "$TARGET"
    ;;
  test)
    start
    close_master
    read -r -a bun_cmd <<< "$("$DIR/scripts/bun-cmd.sh")"
    JEMACS_TRAMP_SSH_INTEGRATION=1 \
      JEMACS_TRAMP_SSH_PORT="$PORT" \
      JEMACS_TRAMP_SSH_PASSWORD=tramp-test \
      "${bun_cmd[@]}" test "$DIR/test/plugins/tramp-ssh.integration.test.ts"
    close_master
    ;;
  *)
    printf 'usage: %s {start|stop|reset|status|test}\n' "$0" >&2
    exit 2
    ;;
esac
