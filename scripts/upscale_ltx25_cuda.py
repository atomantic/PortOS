#!/usr/bin/env python3
"""Generative 2x video upscale on the LTX-2.5 CUDA runtime (#6513).

The Windows/NVIDIA half of the pass #6512 established on MLX: the gated LTX-2.5
Pixel Spatial Upscaler IC-LoRA is fused into the distilled transformer and the
clip being upscaled is the single IC reference, at full strength. The argv, the
model grid and the header-only adapter guards are literally the same code —
`_upscale_contract.py` — because #6511 emits one argument set for both backends
and two copies of that contract would be two things free to drift.

Everything below was READ off the pinned runtime source
(`Lightricks/LTX-2 @ v1.2.0`, the ref `scripts/requirements-ltx25-cuda.txt`
installs), not inferred from the gated model card:

  - `ltx_pipelines.ic_lora.ICLoraPipeline` is the pipeline that fuses an
    IC-LoRA and conditions on a reference clip. It takes the same split
    `ModelPaths`, `spatial_upsampler_path`, `quantization` and `offload_mode`
    that `generate_ltx25_cuda.py` already drives `DistilledPipeline` with, so
    the FP8 cast policy and disk streaming that make a 22B model fit a consumer
    card carry over unchanged. It fuses the adapter into STAGE 1 only
    (`stage_2` is built with `loras=()`) and renders that stage at HALF the
    `height`/`width` it is handed — so, exactly like the MLX runner, this one
    requests twice the output and passes `skip_stage_2=True` (see
    `PIPELINE_REQUEST_MULTIPLIER` in `_upscale_contract.py`); the
    latent-upsample stage 2 never runs.
  - The LoRA is a `LoraPathStrengthAndSDOps(path, strength, sd_ops)` and the
    `sd_ops` is the runtime's own `LTXV_LORA_COMFY_RENAMING_MAP`. Both come
    from `ltx_core.loader`; naming the map here rather than reimplementing it
    is what keeps the fusion guard honest.
  - Quantization-safe fusion is the runtime's contract: `fp8_cast.build_policy`
    ships an `fp8_cast_fuse_rule` that dequantizes the FP8 weight, adds the
    bf16 delta and re-rounds (and falls back to a plain bf16 fuse for the
    linears the downcast map leaves in bf16). So the FP8 policy does NOT break
    fusion — what breaks it silently is a KEY that does not match. `apply_loras`
    skips a weight `model_sd` lacks (`original_weight is None -> continue`), and
    `load_state_dict(..., strict=False)` swallows the rest, so an adapter that
    addresses nothing raises nothing and renders the plain base model.
    `assert_adapter_fuses` is the guard the issue asks for, and it checks
    NUMERICALLY: it intersects renamed keys AND verifies each delta's
    `B @ A` shape against the base weight the fuse would add it to.
  - The model-side key namespace is `LTXV_MODEL_COMFY_RENAMING_MAP`, which
    requires the raw `model.diffusion_model.` prefix and strips it; the LoRA
    map strips a bare `diffusion_model.`. The two meet on the same base names,
    which is exactly what the guard verifies rather than assumes.
  - The schedule is the fixed distilled one — `DISTILLED_SIGMAS` (8) is the
    `__call__` default for stage 1 — which is why this runner, like the MLX
    one, exposes no steps flag.
  - `assert_resolution(..., is_two_stage=True)` demands `% 64` of the REQUEST,
    which the shared contract's `% 64` rule on the output satisfies twice over,
    so a source is refused before a GPU rather than inside the pipeline.

Audio is deliberately NOT taken from the model. `encode_video` is called with
`audio=None` and `finalizeUpscaleOutput` (`upscaleFfmpeg.js`) re-muxes the
ORIGINAL clip's track at offset zero: the adapter is a spatial upscaler, so the
user's real audio is the correct audio, and round-tripping it through the audio
VAE would replace it with a re-synthesized one that also has to survive the
padded tail. A source with no audio yields a silent deliverable, not a failure.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import emit_runtime_fingerprint, establish_process_group, heartbeat  # noqa: E402
# One pinned pack layout, not two: the upscale renders against the SAME split
# checkpoint the plain CUDA render does, so its file list is imported rather
# than restated. The import is side-effect-free — that module defers every
# heavy import into its own `main()`.
from generate_ltx25_cuda import MODEL_FILES  # noqa: E402
# The argv, grid and adapter contract shared with the MLX runner (#6512).
from _upscale_contract import (  # noqa: E402
    REFERENCE_STRENGTH,
    add_upscale_arguments,
    assert_reference_scale_fits,
    conditioned_stage_request,
    entry_shape,
    lora_delta_shapes,
    read_safetensors_header,
    reference_downscale_factor,
    validate_args,
)

FINGERPRINT_PACKAGES = ["torch", "ltx-core", "ltx-pipelines", "transformers", "accelerate", "huggingface-hub"]

# The VRAM floor upstream supports for the 22B distilled pack under FP8 + disk
# streaming, expressed in decimal GB so a nominally-24 GB card clears it after
# the slice its driver reserves and never reports. An upscale renders at twice
# the source's linear dimensions, so it sits strictly above a plain render's
# peak — which is why this gate lives here and not in `generate_ltx25_cuda.py`.
MIN_VRAM_BYTES = 23 * 1000 ** 3

# The adapter fuses at full strength: it is the upscaler itself, not a style
# LoRA being blended in. Distinct from REFERENCE_STRENGTH, which happens to be
# the same number for the same reason and governs the reference conditioning.
ADAPTER_STRENGTH = 1.0


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def parse_args(argv: "list[str] | None" = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="LTX-2.5 CUDA generative video upscale")
    add_upscale_arguments(parser, model_help=(
        "local snapshot directory of the pinned LTX-2.5 split checkpoint "
        "(resolved cache-only by PortOS; never a repo id)"
    ))
    return parser.parse_args(argv)


def validate_device(available: bool, name: "str | None", total_memory: "int | None") -> None:
    """Capability gate: a visible NVIDIA card with enough VRAM to finish.

    Reaching this runner without CUDA is a routing bug in
    `ltxUpscaleRuntimeId()`, and reaching it on a card too small to hold the
    22B pack is a render that dies with an allocator traceback 40 minutes in.
    Both are named here so the queue shows the actionable reason instead.

    An UNKNOWN capacity is not an insufficient one: a driver that does not
    report `total_memory` gets the benefit of the doubt rather than a refusal
    invented from a missing number.
    """
    if not available:
        raise SystemExit(
            "The LTX-2.5 CUDA upscale runner needs a visible NVIDIA device; torch reports none. "
            "Repair the LTX-2.5 CUDA runtime from Video Gen, or run the upscale on an Apple Silicon machine."
        )
    if total_memory is not None and total_memory < MIN_VRAM_BYTES:
        raise SystemExit(
            f"{name or 'This GPU'} reports {total_memory / 1000 ** 3:.1f} GB of VRAM. The LTX-2.5 22B "
            f"distilled upscale renders at twice the source's linear dimensions and needs at least "
            f"{MIN_VRAM_BYTES / 1000 ** 3:.0f} GB."
        )


def validate_model_dir(model_dir: str) -> "dict[str, str]":
    """Resolve the pinned split checkpoint, refusing an incomplete snapshot.

    PortOS resolves the snapshot cache-only and hands over a directory, so a
    missing file means the pack was never fully downloaded (or was deleted
    underneath a queued job). Refusing HERE matters because the runner must
    never resolve its own weights: every LTX loader falls back to a remote
    fetch for a path it cannot stat, which for this pack is an unannounced
    ~68 GB pull inside a render.
    """
    root = Path(model_dir)
    if not root.is_dir():
        raise SystemExit(
            f"The LTX-2.5 model pack is not cached at {model_dir} — "
            "download or repair it in Video Gen before upscaling."
        )
    paths = {key: root / relative for key, relative in MODEL_FILES.items()}
    missing = sorted(str(relative) for key, relative in MODEL_FILES.items() if not paths[key].is_file())
    if missing:
        raise SystemExit(
            f"The LTX-2.5 snapshot at {model_dir} is incomplete: {', '.join(missing)}. "
            "Repair the model in Video Gen."
        )
    return {key: str(path) for key, path in paths.items()}


def transformer_weight_shapes(transformer_path: str, rename) -> "dict[str, tuple[int, ...]]":
    """The transformer's fusable parameter names and shapes, from its header alone.

    `load_state_dict` applies `LTXV_MODEL_COMFY_RENAMING_MAP` to every key, so
    the model's parameter names are a deterministic function of the file's
    header — no tensor I/O and no model in memory. `rename` is that same map,
    passed in rather than restated so the guard can never disagree with the
    loader about which keys exist.

    Only `.weight` keys matter: `_affected_weight_keys` addresses a weight by
    `<prefix>.weight`, and a prequantized pack's sibling `*_scale` tensors are
    folded into their parent at load time rather than fused into.
    """
    header = read_safetensors_header(transformer_path)
    if not header:
        return {}
    shapes = {}
    for raw, entry in header.items():
        if raw == "__metadata__":
            continue
        name = rename(raw)
        if not isinstance(name, str) or not name.endswith(".weight"):
            continue
        shape = entry_shape(entry)
        if shape is not None:
            shapes[name] = shape
    return shapes


def assert_adapter_fuses(adapter_path: str, model_shapes: "dict[str, tuple[int, ...]]", rename) -> int:
    """Refuse an adapter that would fuse into nothing, or into the wrong shape.

    This is the failure #6513 names: `apply_loras` reports nothing when a key
    does not match — the weight is skipped, `load_state_dict(strict=False)`
    swallows the rest, and the render is the un-adapted base model dressed as
    an upscale. "No exception" is not evidence, so the check is the numeric
    one the header already affords: every fusable pair must address a real
    weight AND its `B @ A` product must have that weight's shape, or the delta
    could not be added to it even if the key matched.

    Only headers are read, so this costs no tensor I/O and runs BEFORE the
    pipeline loads anything. Returns the number of weights the adapter will
    actually fuse into, so the render records real coverage.
    """
    header = read_safetensors_header(adapter_path)
    if not header:
        raise SystemExit(
            f"Could not read the adapter's safetensors header at {adapter_path} — "
            "the file is truncated or is not a safetensors weight. Repair it in Video Gen."
        )
    if not model_shapes:
        raise SystemExit(
            "Could not read the LTX-2.5 transformer's weight names, so there is no way to tell whether "
            "the upscale adapter would fuse into anything. Repair the model in Video Gen."
        )
    deltas = lora_delta_shapes(header, rename)
    matched = sorted(set(deltas) & set(model_shapes))
    if not matched:
        raise SystemExit(
            "The upscale adapter's tensors do not address any weight in this transformer, so fusing it "
            "would be a no-op and the 'upscale' would be an un-adapted render. The adapter and the "
            "LTX-2.5 pack are mismatched — repair both in Video Gen."
        )
    mismatched = []
    for key in matched:
        out_features, in_features, rank_a, rank_b = deltas[key]
        if rank_a != rank_b or model_shapes[key] != (out_features, in_features):
            mismatched.append(f"{key} (adapter {out_features}x{in_features}, model {model_shapes[key]})")
    if mismatched:
        raise SystemExit(
            "The upscale adapter's deltas do not match the shape of the weights they address, so the "
            f"fusion would corrupt them: {'; '.join(mismatched[:3])}. The adapter was trained against a "
            "different LTX-2.5 checkpoint — repair both in Video Gen."
        )
    return len(matched)


def main() -> None:
    establish_process_group()
    args = parse_args()
    validate_args(args)
    paths = validate_model_dir(args.model)

    header = read_safetensors_header(args.ic_lora_path)
    scale = reference_downscale_factor(header)
    assert_reference_scale_fits(scale, args.width, args.height)
    # The per-install measurement the queue records beside the registry's
    # declared value — a re-pinned weight is measured, not trusted.
    log(f"UPSCALE_REFERENCE_DOWNSCALE:{scale}")

    log("STAGE:verify-adapter")
    # LTX's documented allocator setting reduces fragmentation on cards that sit
    # close to the model's supported VRAM floor. It must be set before importing
    # torch so CUDA reads it during allocator initialization.
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    import torch

    # Gated before the runtime imports so a CPU-only torch — which installs
    # cleanly on Windows and hides the setup banner — is named as the reason.
    device_index = torch.cuda.current_device() if torch.cuda.is_available() else None
    validate_device(
        torch.cuda.is_available(),
        torch.cuda.get_device_name(device_index) if device_index is not None else None,
        torch.cuda.get_device_properties(device_index).total_memory if device_index is not None else None,
    )

    from ltx_core.loader import LTXV_LORA_COMFY_RENAMING_MAP, LoraPathStrengthAndSDOps
    from ltx_core.model.transformer.model_configurator import LTXV_MODEL_COMFY_RENAMING_MAP
    from ltx_core.model.video_vae import AUTO_TILING, get_video_chunks_number
    from ltx_core.quantization.fp8_cast import build_policy as build_fp8_cast_policy
    from ltx_pipelines.ic_lora import ICLoraPipeline
    from ltx_pipelines.utils.media_io import encode_video
    from ltx_pipelines.utils.model_paths import ModelPaths
    from ltx_pipelines.utils.types import OffloadMode

    emit_runtime_fingerprint("ltx25_cuda", FINGERPRINT_PACKAGES)

    # Both sides of the coverage check are header reads, so a mismatched pair
    # fails in milliseconds — before Gemma, before the DiT, before a GPU.
    fused = assert_adapter_fuses(
        args.ic_lora_path,
        transformer_weight_shapes(paths["transformer"], LTXV_MODEL_COMFY_RENAMING_MAP.apply_to_key),
        LTXV_LORA_COMFY_RENAMING_MAP.apply_to_key,
    )
    log(f"STATUS:Adapter fuses into {fused} transformer weights")

    model_paths = ModelPaths.from_split(
        transformer_path=paths["transformer"],
        text_encoder_path=paths["text_encoder"],
        video_vae_path=paths["video_vae"],
        audio_vae_path=paths["audio_vae"],
        duration_head_path=paths["duration_head"],
    )
    log("STAGE:load-pipeline")
    log(f"STATUS:Loading LTX-2.5 CUDA upscale pipeline ({args.width}x{args.height}, {args.num_frames} frames)")
    with heartbeat("ltx25-cuda-upscale-load"):
        pipe = ICLoraPipeline(
            model_paths=model_paths,
            spatial_upsampler_path=paths["upsampler"],
            loras=[
                LoraPathStrengthAndSDOps(args.ic_lora_path, ADAPTER_STRENGTH, LTXV_LORA_COMFY_RENAMING_MAP),
            ],
            device=torch.device("cuda"),
            quantization=build_fp8_cast_policy(paths["transformer"]),
            # CPU mode pins a model-sized prefetch buffer. The 24 GB VRAM /
            # 32 GB system-RAM tier can exhaust that buffer while Gemma is
            # resident; DISK is upstream's lowest-memory streaming mode.
            offload_mode=OffloadMode.DISK,
        )

    request_width, request_height = conditioned_stage_request(args.width, args.height)
    log("STAGE:inference")
    with heartbeat("ltx25-cuda-upscale-inference"):
        # Twice the output + `skip_stage_2` = one conditioned stage AT the
        # output (see `conditioned_stage_request`).
        # No sigma override: `DISTILLED_SIGMAS` IS the distilled schedule (8)
        # and is this call's stage-1 default. `images=[]` because the
        # reference is the clip, not a still.
        video, _audio, tiling = pipe(
            prompt=args.prompt,
            seed=args.seed,
            height=request_height,
            width=request_width,
            num_frames=args.num_frames,
            frame_rate=args.fps,
            images=[],
            video_conditioning=[(reference, REFERENCE_STRENGTH) for reference in args.ic_reference],
            tiling_config=AUTO_TILING,
            skip_stage_2=True,
        )

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    log("STAGE:mux")
    # `audio=None`: the deliverable's track is re-muxed from the ORIGINAL clip
    # by `finalizeUpscaleOutput`, so keeping the model's re-synthesized one
    # would only replace the user's real audio. See the module docstring.
    encode_video(
        video=video,
        fps=int(args.fps),
        audio=None,
        output_path=str(output),
        video_chunks_number=int(get_video_chunks_number(args.num_frames, tiling)),
    )
    if not output.is_file():
        raise SystemExit(f"The LTX-2.5 upscale completed but did not write {output}.")
    log(f"STATUS:Upscaled {output.name} ({args.width}x{args.height}, {args.num_frames} frames)")


if __name__ == "__main__":
    main()
