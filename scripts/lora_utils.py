"""
Shared LoRA application helpers used by `flux2_macos.py` and
`z_image_turbo.py`. Both runners go through diffusers' `load_lora_weights`
+ `set_adapters` surface — pulling the body out keeps them in lockstep when
diffusers' LoRA API gains new knobs (e.g. fused-scale paths).
"""

import sys
from pathlib import Path


def apply_loras(pipe, lora_paths, lora_scales) -> None:
    """Best-effort LoRA application. On per-LoRA failure (e.g. shape
    mismatch from a Flux.1 LoRA loaded onto Flux.2 / Z-Image) we log and
    continue without that LoRA — the runner still produces a base render
    rather than aborting the whole job."""
    if not lora_paths:
        return
    if not hasattr(pipe, "load_lora_weights"):
        print(
            f"⚠️ pipeline {type(pipe).__name__} doesn't expose load_lora_weights — "
            f"skipping {len(lora_paths)} LoRA(s)",
            file=sys.stderr,
        )
        return
    # Track (adapter_name, scale) together so a failed load at index i doesn't
    # shift the scale of every subsequent successfully-loaded LoRA.
    loaded = []
    for i, path in enumerate(lora_paths):
        adapter = f"lora_{i}"
        print(f"🎚️  loading LoRA: {Path(path).name} (adapter={adapter})", file=sys.stderr, flush=True)
        try:
            pipe.load_lora_weights(path, adapter_name=adapter)
            raw = lora_scales[i] if i < len(lora_scales) else "1.0"
            try:
                scale = float(raw)
            except (TypeError, ValueError):
                scale = 1.0
            loaded.append((adapter, scale))
        except Exception as err:
            print(
                f"⚠️ LoRA load failed for {Path(path).name}: {type(err).__name__}: {err}",
                file=sys.stderr,
            )
    if not loaded:
        return
    adapter_names, scales = zip(*loaded)
    if hasattr(pipe, "set_adapters"):
        try:
            pipe.set_adapters(adapter_names, adapter_weights=scales)
            print(f"✅ active LoRA adapters: {list(zip(adapter_names, scales))}", file=sys.stderr)
        except Exception as err:
            print(f"⚠️ set_adapters failed: {type(err).__name__}: {err}", file=sys.stderr)
