#!/usr/bin/env python3
"""Standalone runtime-fingerprint probe.

Prints a single JSON object describing the runtime environment of the venv it is
run in — the resolved package versions (ltx/mlx/torch/…) plus chip/os/python —
WITHOUT running a render. Invoked per installed bring-your-own-venv runtime by
`GET /api/video-gen/status` (server/services/videoGen/local.js
resolveRuntimeFingerprint) so the UI can show "what am I running" on demand.

The same fingerprint is emitted inline at render time by the generate_* helpers
via `_runner_common.emit_runtime_fingerprint`; this script is the no-render path
and reuses the identical `build_runtime_fingerprint` definition so the two never
drift.

Usage: python runtime_fingerprint.py <runtime_id> [distribution_name ...]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Same-dir sibling import (mirrors generate_ltx2.py / generate_av_lora.py).
# _runner_common is stdlib-only at import time, so this is safe from any venv.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import build_runtime_fingerprint  # noqa: E402


def main() -> int:
    runtime_id = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    packages = sys.argv[2:]
    print(json.dumps(build_runtime_fingerprint(runtime_id, packages)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
