#!/usr/bin/env python3
"""Probe whether a pinned MiniMax H3 checkout can apply LoRAs at runtime.

H3's shipped DiT is quantized, so a LoRA can only be applied the way the
reference implementation does it: read each target layer's *logical* dimensions
from the quantization metadata (the packed-uint32 storage shapes never match a
LoRA's) and add the deltas during the forward pass, never fusing them into the
quantized weights.

PortOS does not implement that applicator — it consumes one. The contract is a
`minimax_h3_mlx.lora` module exposing a callable `apply_loras(transformer,
loras)`, where `loras` is a list of `{"path": str, "scale": float}` mappings.
Exit 0 means the installed checkout satisfies the contract and PortOS may offer
LoRAs on this runtime; any non-zero exit means it does not, and the render path
keeps rejecting them with a precise reason.

Kept separate from minimax_h3_runtime_probe.py so a runtime that is perfectly
healthy for plain renders is never marked unready just because it predates the
LoRA applicator.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

from _runner_common import register_source_namespace


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: minimax_h3_lora_probe.py <runtime-dir>")
    runtime_dir = Path(sys.argv[1]).resolve()
    package_dir = runtime_dir / "minimax_h3_mlx"
    if not (package_dir / "pipeline.py").is_file():
        raise RuntimeError(f"MiniMax H3 runtime source is missing under {runtime_dir}.")
    register_source_namespace("minimax_h3_mlx", package_dir)
    lora = importlib.import_module("minimax_h3_mlx.lora")
    if not callable(getattr(lora, "apply_loras", None)):
        raise RuntimeError(
            "minimax_h3_mlx.lora does not expose a callable apply_loras(transformer, loras)."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
