#!/usr/bin/env python3
"""PortOS LoRA wrapper for notapalindrome's `mlx_video.generate_av` runtime.

The stock `python -m mlx_video.generate_av` CLI (used for video models with
`runtime: 'mlx_video'` in data/media-models.json) has no `--lora` flag. But the
`mlx-video-with-audio` package ships an LTX-aware LoRA subsystem (`mlx_video.lora`,
with `_normalize_ltx_lora_key`) — it's just never called from the AV generator.

This wrapper closes that gap WITHOUT reimplementing generate_av's ~1000-line
generation loop:

  1. Parse `--user-loras` (a JSON list of {path, strength}) out of argv; everything
     else passes through untouched to generate_av's own argparse.
  2. Load the LoRAs into the package's `module_to_loras` map.
  3. Monkeypatch the two transformer-weight load seams generate_av uses
     (`load_unified_weights` for the single-file layout, `sanitize_transformer_weights`
     for the split-weight layout) so the LoRA deltas merge into the transformer
     weights as they're loaded.
  4. Run `generate_av.main()` — so the SSE protocol (STAGE:/STATUS:/DOWNLOAD: and
     the final {"video_path": ...} JSON line) is byte-for-byte identical to the
     non-LoRA path the Node videoGen service already parses.

Scope: NON-quantized (bf16) LTX-2.x models only — the merge runs with
`quantization_bits=0`. The Node side gates this via isMlxVideoLtxLoraCapable()
(server/lib/runners.js), so a quantized q4/q8 model never reaches this script.

Runs in the SAME venv as `mlx_video.generate_av` (the configured pythonPath), not
a separate BYOV venv.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def emit_status(msg: str) -> None:
    """STATUS: line — routed to PortOS SSE as `status` (mirrors generate_ltx2.py)."""
    print(f"STATUS:{msg}", file=sys.stderr, flush=True)


def _parse_user_loras(raw: str | None) -> list[tuple[str, float]]:
    """Parse --user-loras JSON into a list of (path, strength) tuples.

    Strict validation so a Node-side bug surfaces here before any model load.
    Each entry must be {path: str (existing file), strength: number}. Returns []
    when --user-loras is unset.
    """
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise SystemExit(f"--user-loras is not valid JSON: {e}")
    if not isinstance(data, list):
        raise SystemExit("--user-loras must be a JSON list of {path, strength}")
    specs: list[tuple[str, float]] = []
    for i, item in enumerate(data):
        if not isinstance(item, dict) or "path" not in item:
            raise SystemExit(f"user-loras[{i}] must be an object with 'path'")
        path = item["path"]
        if not isinstance(path, str) or not path:
            raise SystemExit(f"user-loras[{i}].path must be a non-empty string")
        if not Path(path).exists():
            raise SystemExit(f"user-loras[{i}].path does not exist: {path}")
        strength = item.get("strength", 1.0)
        try:
            strength = float(strength)
        except (TypeError, ValueError):
            raise SystemExit(f"user-loras[{i}].strength must be a number")
        specs.append((path, strength))
    return specs


def _fuse(weights: dict, specs: list[tuple[str, float]]) -> dict:
    """Merge each selected LoRA's deltas into the transformer weights (bf16, no
    quantization), validating that EVERY LoRA matched at least one module.

    apply_loras_to_weights normalizes the LoRA keys to LTX model keys
    (_normalize_ltx_lora_key) and returns a NEW dict with the merged weights;
    unchanged keys keep their original array identity, which is how we count how
    many modules each LoRA actually matched.

    LoRAs are applied ONE AT A TIME rather than as a single combined map. The
    result is numerically identical (each LoRA contributes an additive delta to
    the base weight, so `(W+Δa)+Δb == W+Δa+Δb`), but per-LoRA application lets us
    attribute matches to the specific LoRA. A combined apply would only tell us
    that *some* module changed across the whole set — so a multi-LoRA selection
    where one LoRA is incompatible (zero matching keys) would silently skip it
    while the render is still recorded as using it. Failing per-LoRA keeps the
    history honest: if any selected LoRA matches nothing, refuse the render.
    """
    from mlx_video.lora.types import LoRAConfig
    from mlx_video.lora.loader import load_multiple_loras
    from mlx_video.lora.apply import apply_loras_to_weights

    merged = weights
    for path, strength in specs:
        name = Path(path).name
        module_to_loras = load_multiple_loras([LoRAConfig(path=Path(path), strength=strength)])
        before = merged
        merged = apply_loras_to_weights(before, module_to_loras, quantization_bits=0)
        applied = sum(1 for k in merged if k in before and merged[k] is not before[k])
        if applied == 0:
            raise SystemExit(
                f"LoRA '{name}' matched no transformer modules — it's incompatible "
                "with this model (key mismatch). Refusing to render a video "
                "mislabeled as using it."
            )
        emit_status(f"Merged '{name}' into {applied} transformer module(s)")
    return merged


def _install_lora_patches(specs: list[tuple[str, float]]):
    """Monkeypatch generate_av's two transformer-weight load seams so each
    selected LoRA fuses in (and is validated) as the weights are loaded.

    Returns the imported generate_av module so the caller can run its main().
    """
    import mlx_video.generate_av as gav

    names = ", ".join(Path(p).name for p, _ in specs)
    emit_status(f"Fusing {len(specs)} user LoRA(s) into the transformer: {names}")

    # Seam 1: single-file ("unified") layout. load_unified_weights is called for
    # several prefixes (transformer., audio_vae., vocoder.) — only fuse the
    # transformer.
    _orig_load_unified = gav.load_unified_weights

    def _patched_load_unified(model_path, prefix):
        weights = _orig_load_unified(model_path, prefix)
        if prefix == "transformer.":
            return _fuse(weights, specs)
        return weights

    gav.load_unified_weights = _patched_load_unified

    # Seam 2: split-weight layout. sanitize_transformer_weights is only ever
    # called on the transformer, so fuse unconditionally.
    _orig_sanitize = gav.sanitize_transformer_weights

    def _patched_sanitize(raw_weights):
        return _fuse(_orig_sanitize(raw_weights), specs)

    gav.sanitize_transformer_weights = _patched_sanitize

    return gav


def main() -> None:
    # allow_abbrev=False so a future generate_av flag that prefix-matches
    # `--user-loras` (e.g. `--user-...`) can't be greedily swallowed here — only
    # the exact token is consumed; everything else passes through verbatim.
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("--user-loras", default=None)
    ns, passthrough = parser.parse_known_args()

    specs = _parse_user_loras(ns.user_loras)
    if not specs:
        raise SystemExit(
            "generate_av_lora.py requires --user-loras; use `python -m "
            "mlx_video.generate_av` directly for non-LoRA renders."
        )

    gav = _install_lora_patches(specs)

    # Hand the remaining args to generate_av's own argparse and run it. Its
    # stdout/stderr (STAGE:/STATUS:/DOWNLOAD: + final JSON) flow straight through.
    sys.argv = [sys.argv[0], *passthrough]
    gav.main()


if __name__ == "__main__":
    main()
