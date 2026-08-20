#!/usr/bin/env python3
"""Import-probe a pinned MiniMax H3 source package without trusting its root.

Run at Install / Repair (`isByovRuntimeReady`, `scripts/setup-image-video.sh`),
so this is also where a moved pin gets reported: `verify_pin_seams()` asserts
every method `generate_minimax_h3.py` patches at render time is still there and
still the shape it patches. Those corrections keep their own guards — they are
the last line for a checkout overridden after install — but a pin bump that
breaks one should fail the bump, not the first keyframe render after it.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

from _runner_common import register_source_namespace
from _minimax_h3_mlx_pins import verify_pin_seams


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: minimax_h3_runtime_probe.py <runtime-dir>")
    runtime_dir = Path(sys.argv[1]).resolve()
    package_dir = runtime_dir / "minimax_h3_mlx"
    if not (package_dir / "pipeline.py").is_file():
        raise RuntimeError(f"MiniMax H3 runtime source is missing under {runtime_dir}.")
    register_source_namespace("minimax_h3_mlx", package_dir)
    importlib.import_module("minimax_h3_mlx.pipeline")
    # Kept ahead of verify_pin_seams even though that reaches into the same
    # package: a venv that never installed mlx-vlm has to report as an
    # ImportError naming the missing distribution, not as a pin that moved.
    importlib.import_module("mlx_vlm.models.qwen3_vl.language")
    verify_pin_seams()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
