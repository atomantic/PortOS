#!/usr/bin/env python3
"""Probe whether PortOS can apply LoRAs to a pinned MiniMax H3 checkout.

H3's shipped DiT is quantized, so a LoRA must read each target layer's logical
dimensions from the quantization metadata (the packed-uint32 storage shapes
never match a LoRA's) and add the deltas during the forward pass, never fusing
them into the quantized weights.

PortOS owns the applicator in scripts/ml/minimax_h3_lora.py. This probe imports
the pinned H3 DiT and applies a tiny real LoRA to a quantized MLX projection, so
it verifies both sides of the integration without loading the 33B checkpoint.
Exit 0 means the installed checkout and the local applicator satisfy the
contract and PortOS may offer LoRAs on this runtime; any non-zero exit means it
does not, and the render path keeps rejecting them with a precise reason.

Kept separate from minimax_h3_runtime_probe.py so a runtime that is perfectly
healthy for plain renders is never marked unready just because it predates the
LoRA applicator.
"""

from __future__ import annotations

import importlib
import sys
import tempfile
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
    importlib.import_module("minimax_h3_mlx.dit")
    from minimax_h3_lora import apply_loras
    import mlx.core as mx
    import mlx.nn as nn

    class Attention(nn.Module):
        def __init__(self):
            super().__init__()
            self.heads = 2
            self.head_dim = 4
            self.qkv_proj = nn.Linear(32, 24, bias=False)

    class Block(nn.Module):
        def __init__(self):
            super().__init__()
            self.attn = Attention()

    class ProbeDiT(nn.Module):
        def __init__(self):
            super().__init__()
            self.blocks = [Block()]

    transformer = ProbeDiT()
    nn.quantize(
        transformer,
        group_size=32,
        bits=8,
        class_predicate=lambda path, module: path.endswith("qkv_proj"),
    )
    with tempfile.TemporaryDirectory(prefix="portos-h3-lora-probe-") as temp:
        lora_path = Path(temp) / "probe.safetensors"
        mx.save_safetensors(
            str(lora_path),
            {
                "blocks.0.attn.qkv_proj.lora_A.weight": mx.zeros((1, 32)),
                "blocks.0.attn.qkv_proj.lora_B.weight": mx.zeros((24, 1)),
                "blocks.0.attn.qkv_proj.alpha": mx.array([1.0]),
            },
        )
        apply_loras(transformer, [{"path": str(lora_path), "scale": 1.0}])
        output = transformer.blocks[0].attn.qkv_proj(mx.zeros((1, 1, 32)))
        mx.eval(output)
        if tuple(output.shape) != (1, 1, 24):
            raise RuntimeError(f"MiniMax H3 LoRA probe produced an unexpected shape: {output.shape}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
