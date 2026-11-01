#!/bin/sh
# shenlan-dev — local source launcher; rebuild only when tracked inputs change.
# Install by putting a symlink to this script on PATH.
# Usage: shenlan-dev [args...] (for example, --version or run "task").
set -e

SCRIPT_PATH=$0
RESOLVED=$(readlink "$SCRIPT_PATH" 2>/dev/null || echo "$SCRIPT_PATH")
case "$RESOLVED" in
  /*|[A-Za-z]:/*) ;;
  *) RESOLVED="$(CDPATH='' cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)/$RESOLVED" ;;
esac
REPO_DIR=$(CDPATH='' cd -- "$(dirname -- "$RESOLVED")/.." && pwd)
exec node "$REPO_DIR/scripts/shenlan-dev.mjs" "$@"
