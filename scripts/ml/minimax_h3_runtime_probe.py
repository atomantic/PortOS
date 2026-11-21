#!/usr/bin/env python3
"""Import-probe a pinned MiniMax H3 source package without trusting its root.

Two callers, and they want different strictness — hence `--verify-seams`:

  - `isByovRuntimeReady` (server/services/videoGen/runtimes.js) runs this bare,
    as a readiness check. It must answer ONLY "can this runtime render at all",
    because a false negative there sets `byovGateBlocked` in the Video Gen page
    and disables Generate outright. Same rule minimax_h3_lora_probe.py is kept
    separate for: a runtime that is perfectly healthy for plain renders is never
    marked unready over a capability it doesn't need.

  - `scripts/setup-image-video.sh` runs it WITH the flag at Install / Repair,
    where the extra strictness is what the user asked for and a failure is
    actionable at the action that caused it.

The flag adds `verify_pin_seams()`: every method of the pinned encoder that
`generate_minimax_h3.py` patches, asserted up front. Those adapters are only
correct against the exact implementation they were written for, and their
render-time guards otherwise fire minutes later — after a cache resolve and a
pipeline load, and only on the image-conditioned path three of them serve. A pin
bump reaches Install / Repair anyway (a moved MINIMAX_H3_EXPECTED_REVISION fails
`isByovRuntimeCurrent`, and a re-locked mlx-vlm needs a re-sync), so gating the
strict check there costs no coverage a stock user would ever have seen.
"""

from __future__ import annotations

import argparse
import importlib
from pathlib import Path

from _runner_common import register_source_namespace
from _minimax_h3_mlx_pins import verify_pin_seams


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runtime_dir")
    parser.add_argument("--verify-seams", action="store_true",
                        help="also assert the encoder seams PortOS patches (Install / Repair only)")
    args = parser.parse_args()

    runtime_dir = Path(args.runtime_dir).resolve()
    package_dir = runtime_dir / "minimax_h3_mlx"
    if not (package_dir / "pipeline.py").is_file():
        raise RuntimeError(f"MiniMax H3 runtime source is missing under {runtime_dir}.")
    register_source_namespace("minimax_h3_mlx", package_dir)
    importlib.import_module("minimax_h3_mlx.pipeline")
    # The bare readiness path keeps this one import: the vision tower's language
    # model is loaded by every keyframe render, so a checkout that cannot resolve
    # it is broken for real rather than merely un-patchable.
    importlib.import_module("mlx_vlm.models.qwen3_vl.language")
    if args.verify_seams:
        verify_pin_seams()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
