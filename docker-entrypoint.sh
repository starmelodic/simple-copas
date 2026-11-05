#!/bin/sh
# Drop root and fix volume ownership, then exec the real process.
set -e

if [ "$(id -u)" = "0" ]; then
  if [ -n "$DATA_DIR" ] && [ -d "$DATA_DIR" ]; then
    chown -R app:app "$DATA_DIR" 2>/dev/null || true
  fi
  exec su-exec app "$@"
fi

exec "$@"
