#!/usr/bin/env bash
# PortOS owns setup; the upstream script resolves dependencies and tolerates failed builds.
set -euo pipefail
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${PYTHON_BIN:-}"
if [[ -z "$PY" ]]; then
  for candidate in /opt/homebrew/opt/python@3.13/bin/python3.13 "$(command -v python3.13 2>/dev/null || true)"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then PY="$candidate"; break; fi
  done
else
  PY="$(command -v "$PY" 2>/dev/null || true)"
fi
[[ -n "$PY" && -x "$PY" ]] || { echo 'TRELLIS.2 Metal requires Python 3.13. Install python@3.13 or set PYTHON_BIN.' >&2; exit 1; }
exec "$PY" "$SCRIPTS_DIR/setup-trellis2-mps.py" "$@"
