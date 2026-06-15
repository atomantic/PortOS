"""
Shared LoRA application helpers used by `flux2_macos.py` and
`z_image_turbo.py`. Both runners go through diffusers' `load_lora_weights`
+ `set_adapters` surface — pulling the body out keeps them in lockstep when
diffusers' LoRA API gains new knobs (e.g. fused-scale paths).
"""

import re
import sys
from pathlib import Path

# mflux trains FLUX.2 double-block attention `to_out` as a bare Linear and
# exports the key `...transformer_blocks.N.attn.to_out.lora_*`. But diffusers'
# Flux2Attention wraps that projection in `ModuleList([Linear, Dropout])`, so
# PEFT can only attach to the inner `.0` — loading the bare key fails with
# "Target module ModuleList(...) is not supported" and the whole adapter is
# dropped (silent base render). Insert the `.0`. The anchor `\.transformer_blocks`
# (leading dot) deliberately skips `single_transformer_blocks`, whose `to_out`
# IS a bare Linear in diffusers and is already correctly keyed. Every other
# mflux target (to_q/k/v, add_*_proj, to_add_out, ff.linear_in/out, ff_context,
# single to_qkv_mlp_proj/to_out) already matches diffusers Flux2 naming.
_TO_OUT_RE = re.compile(r"(\.transformer_blocks\.\d+\.attn\.to_out)(\.(?:lora_[AB]|alpha))")


def _remap_mflux_flux2_keys(state_dict):
    """Return (remapped_dict, n_changed) with double-block to_out keys fixed."""
    out = {}
    changed = 0
    for k, v in state_dict.items():
        nk = _TO_OUT_RE.sub(lambda m: f"{m.group(1)}.0{m.group(2)}", k)
        if nk != k:
            changed += 1
        out[nk] = v
    return out, changed


def _lora_needs_to_out_remap(path) -> bool:
    """Cheap header-only peek — true iff this is an mflux-style FLUX.2 adapter
    keying double-block to_out without the diffusers `.0`."""
    try:
        from safetensors import safe_open
        with safe_open(path, framework="pt") as f:
            return any(_TO_OUT_RE.search(k) for k in f.keys())
    except Exception:
        return False  # not a safetensors / unreadable → let load_lora_weights handle it


def _load_one_lora(pipe, path, adapter) -> None:
    """diffusers load_lora_weights, normalizing mflux double-block to_out keys
    to the diffusers `.0` form first when needed (passing a state_dict instead
    of the path). Non-mflux adapters load straight from the path, unchanged."""
    if _lora_needs_to_out_remap(path):
        from safetensors.torch import load_file
        sd, changed = _remap_mflux_flux2_keys(load_file(path))
        print(f"🔁 mflux adapter: remapped {changed} double-block to_out key(s) → diffusers .0 form",
              file=sys.stderr, flush=True)
        pipe.load_lora_weights(sd, adapter_name=adapter)
    else:
        pipe.load_lora_weights(path, adapter_name=adapter)


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
            _load_one_lora(pipe, path, adapter)
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
    # `zip(*loaded)` yields tuples; diffusers' set_adapters does arithmetic over
    # the weights (e.g. `weight / len(...)`) and raises `'tuple' / int` on a
    # tuple, so hand it plain lists.
    adapter_names, scales = (list(x) for x in zip(*loaded))
    if hasattr(pipe, "set_adapters"):
        try:
            pipe.set_adapters(adapter_names, adapter_weights=scales)
            print(f"✅ active LoRA adapters: {list(zip(adapter_names, scales))}", file=sys.stderr)
        except Exception as err:
            print(f"⚠️ set_adapters failed: {type(err).__name__}: {err}", file=sys.stderr)
