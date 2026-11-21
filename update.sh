#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"
# Keep the supervisor's owned PID/process group when replacing this shell.
if [ -z "${PORTOS_PEER_UPDATE_OPERATION_ID:-}${PORTOS_DEFERRED_UPDATE_ID:-}" ]; then
  exec node scripts/deferred-update.mjs "$@"
fi
exec node scripts/update.mjs "$@"
