#!/usr/bin/env python3
"""Generative 2x video upscale on the LTX-2.5 MLX runtime (#6512).

The pass fuses the gated LTX-2.5 Pixel Spatial Upscaler IC-LoRA into the
distilled transformer and conditions on the clip being upscaled, so it is an
IC-LoRA render whose single reference IS the source. That is why the argv is
the IC flag alphabet `renderArgs.buildLtxUpscaleArgs()` already emits rather
than a second vocabulary, and why the reference-count bounds arrive as flags:
`server/lib/icLoraWeights.js` is the single source of truth across both
languages, and a Python-side default would be a second table free to drift.

Everything this runner needs was READ off the pinned runtime
(`~/.portos/ltx-2.5-mlx`, `LTX25_EXPECTED_REVISION`), not inferred from the
gated model card:

  - The 2.5 fork ships its OWN `ltx_pipelines_mlx.ic_lora.ICLoraPipeline`, so
    there is nothing to compose with `generate_ltx2.py`'s 2.3 encoder-shim /
    unified-weight-filter machinery. This runner talks to the 2.5 pipeline
    directly and imports none of it.
  - The correct text encoder is the gemma4 conditioner the 2.5 pack ships under
    `<model_dir>/text_encoder/`. `PromptEncoder._text_encoder_source()` prefers
    it and otherwise falls back to the remote 2.3 Gemma 3 id — a wrong encoder
    AND an unannounced multi-GB download — so `validate_model_dir` refuses a
    pack that lacks it instead of letting that fallback happen.
  - The schedule is the fixed distilled one: `DISTILLED_SIGMAS` is 8 steps and
    `STAGE_2_SIGMAS` is 3. Passing no step counts selects exactly those, which
    is why this runner exposes no steps flag.
  - Quantization-safe fusion is the runtime's own contract: `apply_loras()`
    dequantizes an int4/int8 weight, adds the delta, and re-quantizes. What it
    does NOT do is complain when an adapter addresses keys the transformer does
    not have — every delta is simply missing, the fusion is a silent no-op, and
    the render is the plain base model. `assert_adapter_fuses` is the guard for
    that: it is the "loads but produces garbage" case #6512 names.
  - `reference_downscale_factor` is read from the adapter's safetensors
    `__metadata__` (`iclora_utils.read_lora_reference_downscale_factor`) and
    enforced against the STAGE-1 dims, which are half the output. It is
    reported on stderr so the value is recorded rather than guessed.

Phosphene's fast source-latent refinement is deliberately NOT ported — #6502
rules it fork-specific, and the current pins take no such arguments.
"""

from __future__ import annotations

import argparse
import json
import platform
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import emit_runtime_fingerprint, heartbeat  # noqa: E402

# The 2.5 pack's own prompt conditioner. Its absence is a hard refusal rather
# than a fallback — see the module docstring.
TEXT_ENCODER_DIRNAME = "text_encoder"

# The LTX-2.5 two-stage grid, mirrored from `LTX_GRID` in
# `server/services/videoGen/upscalePlan.js` and confirmed against the runtime:
# Stage 1 renders at `height // 2` / `width // 2` and the video VAE's spatial
# compression is 32 (`compute_video_latent_shape`), so the OUTPUT axis must be
# divisible by 64. The temporal compression is 8 and the reference encoder
# needs a (1 + 8k)-frame input, so `frames % 8 == 1` with a floor of 9.
SPATIAL_MULTIPLE = 64
FRAME_MODULUS = 8
FRAME_REMAINDER = 1
MIN_FRAMES = 9

# Stage 1 renders at half the requested output, and it is those halved dims the
# IC encoder divides by `reference_downscale_factor`.
STAGE1_DIVISOR = 2

# The upscale contract carries no prompt (#6511): the source clip is the whole
# conditioning signal, and inventing text steering would push synthesized
# detail toward content the user never asked for. The empty string is the
# neutral choice — the distilled schedule runs no CFG, so the prompt is pure
# conditioning rather than a guidance pole. `--prompt` exists so #6514's
# verification matrix can probe the effect without changing the argv contract.
DEFAULT_PROMPT = ""

# Full reference conditioning: unlike a control/pose IC render, the reference
# here is the picture itself, so there is nothing to attenuate.
REFERENCE_STRENGTH = 1.0

FINGERPRINT_PACKAGES = ["ltx_pipelines_mlx", "ltx_core_mlx", "mlx", "mlx_metal"]

# A real safetensors header is a few KB to low-MB; anything past this is a
# corrupt length we refuse to allocate for. Mirrors the same bound in
# `server/lib/safetensors.js`.
MAX_HEADER_BYTES = 100 * 1024 * 1024


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def parse_args(argv: "list[str] | None" = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="LTX-2.5 MLX generative video upscale")
    parser.add_argument("--model", required=True,
                        help="local snapshot directory of the pinned LTX-2.5 MLX pack "
                             "(resolved cache-only by PortOS; never a repo id)")
    parser.add_argument("--ic-lora-path", required=True,
                        help="local .safetensors of the Pixel Spatial Upscaler adapter")
    parser.add_argument("--ic-reference", action="append", default=[],
                        help="the clip being upscaled, already aligned to the model grid")
    parser.add_argument("--ic-min-references", type=int, required=True)
    parser.add_argument("--ic-max-references", type=int, required=True)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--num-frames", type=int, required=True)
    parser.add_argument("--fps", type=float, required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--output", required=True)
    return parser.parse_args(argv)


def read_safetensors_header(path: str) -> "dict | None":
    """Parse a safetensors JSON header with the stdlib alone.

    Deliberately not `safetensors.safe_open`: this runs during validation, in a
    bare interpreter, before any runtime import — which is what keeps the whole
    argument contract testable without an MLX wheel. Returns None for a missing,
    truncated, or non-safetensors file rather than raising, so the caller states
    the refusal in its own words.
    """
    try:
        with open(path, "rb") as handle:
            raw_len = handle.read(8)
            if len(raw_len) < 8:
                return None
            header_len = struct.unpack("<Q", raw_len)[0]
            if header_len <= 0 or header_len > MAX_HEADER_BYTES:
                return None
            raw = handle.read(header_len)
            if len(raw) < header_len:
                return None
            parsed = json.loads(raw.decode("utf-8"))
            return parsed if isinstance(parsed, dict) else None
    except (OSError, ValueError, struct.error):
        return None


def reference_downscale_factor(header: "dict | None") -> int:
    """The adapter's declared `reference_downscale_factor`, defaulting to 1.

    Matches `iclora_utils.read_lora_reference_downscale_factor`, which the
    pipeline uses as the real value. Read here too so the resolution rule can be
    stated BEFORE a multi-minute render commits to it — and so PortOS can record
    the measured factor rather than the `null` its registry honestly holds for a
    gated weight nobody has opened yet.
    """
    metadata = (header or {}).get("__metadata__")
    if not isinstance(metadata, dict):
        return 1
    try:
        scale = int(metadata.get("reference_downscale_factor", 1))
    except (TypeError, ValueError):
        return 1
    return scale if scale >= 1 else 1


def lora_target_keys(names) -> "set[str]":
    """Base-weight keys an adapter can fuse into, from its ALREADY-RENAMED names.

    `apply_loras` pairs `<prefix>.lora_A.weight` with `<prefix>.lora_B.weight`
    and skips a prefix missing either half, so a half-pair contributes nothing
    and must not count as coverage. Takes renamed names rather than raw ones on
    purpose: the ComfyUI rename table belongs to the runtime
    (`LTXV_LORA_COMFY_RENAMING_MAP`), and copying it here would be a second
    table free to drift from the one that actually fuses.
    """
    prefixes = {"lora_A": set(), "lora_B": set()}
    for name in names:
        for half, bucket in prefixes.items():
            suffix = f".{half}.weight"
            if isinstance(name, str) and name.endswith(suffix):
                bucket.add(name[: -len(suffix)])
    return {f"{prefix}.weight" for prefix in prefixes["lora_A"] & prefixes["lora_B"]}


def validate_host(system: str, machine: str) -> None:
    """Capability gate: this runner is Apple-Silicon-only.

    MLX has no non-Metal backend, so an Intel Mac or a Linux box reaching here
    is a routing bug in `ltxUpscaleRuntimeId()`. Named explicitly so the queue
    shows the actionable reason rather than an import traceback.
    """
    if system != "Darwin" or machine != "arm64":
        raise SystemExit(
            f"The LTX-2.5 MLX upscale runner needs Apple Silicon; this host reports {system}/{machine}. "
            "Use the CUDA backend on an NVIDIA machine instead."
        )


def validate_args(args: argparse.Namespace) -> None:
    """Everything checkable before a GPU is committed.

    Mirrors `validate_args` in `scripts/generate_ltx25_cuda.py` on the grid so
    both backends refuse the same sources, and mirrors `run_ic_lora` on the
    reference contract so a direct/script caller gets the same guard the queue
    does. Every refusal is a `SystemExit` string the queue surfaces verbatim.
    """
    if args.width % SPATIAL_MULTIPLE or args.height % SPATIAL_MULTIPLE:
        raise SystemExit(
            f"The two-stage LTX-2.5 pipeline requires width and height divisible by {SPATIAL_MULTIPLE}; "
            f"got {args.width}x{args.height}."
        )
    if args.num_frames < MIN_FRAMES or args.num_frames % FRAME_MODULUS != FRAME_REMAINDER:
        raise SystemExit(
            f"LTX-2.5 num-frames must be at least {MIN_FRAMES} and satisfy "
            f"frames % {FRAME_MODULUS} == {FRAME_REMAINDER}; got {args.num_frames}."
        )
    if not args.fps > 0:
        raise SystemExit(f"--fps must be positive; got {args.fps}.")
    if args.seed < 0:
        raise SystemExit(f"--seed must be non-negative; got {args.seed}.")

    lo, hi = args.ic_min_references, args.ic_max_references
    if lo < 1 or hi < lo:
        raise SystemExit(
            f"--ic-min-references/--ic-max-references must satisfy 1 <= min <= max; got {lo}/{hi}"
        )
    references = list(args.ic_reference or [])
    if not (lo <= len(references) <= hi):
        expected = f"exactly {lo}" if lo == hi else f"{lo}-{hi}"
        raise SystemExit(
            f"The upscale adapter needs {expected} --ic-reference clip(s); got {len(references)}"
        )
    for reference in references:
        if not Path(reference).is_file():
            raise SystemExit(f"--ic-reference does not exist: {reference}")

    # A path, never a repo id. `ICLoraPipeline._resolve_lora_path` falls back to
    # `snapshot_download` for anything that is not an existing file, which for
    # this gated adapter is a 401 deep inside a render — and for any repo, a pull
    # PortOS never announced. The download surface owns every fetch.
    if not Path(args.ic_lora_path).is_file():
        raise SystemExit(
            f"The Pixel Spatial Upscaler adapter is not on disk at {args.ic_lora_path} — "
            "download it from the Video Gen model panel before upscaling."
        )


def validate_model_dir(model_dir: str) -> Path:
    """Resolve the pinned LTX-2.5 pack, refusing a pack without its conditioner.

    PortOS resolves the snapshot cache-only and hands over a directory, so a
    missing one means the pack was never downloaded (or was deleted underneath a
    queued job). The `text_encoder/` check is the load-bearing half: without it
    `PromptEncoder` silently falls back to the remote LTX-2.3 Gemma 3 id, which
    is both the wrong conditioner for these weights and an unannounced download.
    """
    root = Path(model_dir)
    if not root.is_dir():
        raise SystemExit(
            f"The LTX-2.5 MLX model pack is not cached at {model_dir} — "
            "download or repair it in Video Gen before upscaling."
        )
    if not (root / TEXT_ENCODER_DIRNAME / "config.json").is_file():
        raise SystemExit(
            f"The LTX-2.5 pack at {model_dir} is missing {TEXT_ENCODER_DIRNAME}/config.json, so the "
            "pipeline would fall back to the LTX-2.3 Gemma 3 conditioner and fetch it at render time. "
            "Repair the model in Video Gen."
        )
    return root


def assert_reference_scale_fits(scale: int, width: int, height: int) -> None:
    """Enforce the adapter's own resolution rule on the STAGE-1 dimensions.

    `append_ic_lora_reference_video_conditionings` divides the dims it is HANDED
    by the factor, and `ICLoraPipeline.generate` hands it `height // 2` /
    `width // 2`. Stating the rule in OUTPUT terms is what makes the message
    actionable — the user picked an output size, not a stage size.
    """
    if scale <= 1:
        return
    stage_h, stage_w = height // STAGE1_DIVISOR, width // STAGE1_DIVISOR
    if stage_h % scale == 0 and stage_w % scale == 0:
        return
    required = scale * STAGE1_DIVISOR
    raise SystemExit(
        f"This adapter downscales its reference by {scale}, so the output dimensions must be "
        f"divisible by {required}; got {width}x{height}."
    )


def resolve_transformer_path(model_dir: Path) -> "Path | None":
    """The DiT weight file `ICLoraPipeline.load()` would pick, or None.

    Mirrors that method exactly: the plain `transformer.safetensors` wins, else
    `BasePipeline._resolve_safetensors(model_dir, "transformer-distilled")`
    takes the lexicographically last versioned file and falls back to the
    unversioned name.
    """
    plain = model_dir / "transformer.safetensors"
    if plain.is_file():
        return plain
    versioned = sorted(model_dir.glob("transformer-distilled-*.safetensors"))
    if versioned:
        return versioned[-1]
    fallback = model_dir / "transformer-distilled.safetensors"
    return fallback if fallback.is_file() else None


def transformer_weight_keys(transformer_path: Path) -> "set[str]":
    """The transformer's fusable parameter names, read from its header alone.

    `load_transformer` loads the file through
    `load_split_safetensors(path, prefix="transformer.")`, which keeps only the
    prefixed keys and strips the prefix — so the model's parameter names are a
    deterministic function of the file's header, with no tensor I/O and no
    model in memory. Only `.weight` keys matter: `_prepare_deltas` addresses a
    weight by `<prefix>.weight`, and a quantized pack's sibling
    `.scales`/`.biases` are carried along with it rather than fused into.
    """
    header = read_safetensors_header(str(transformer_path))
    if not header:
        return set()
    prefix = "transformer."
    return {
        name[len(prefix):]
        for name in header
        if name != "__metadata__" and name.startswith(prefix) and name.endswith(".weight")
    }


def assert_adapter_fuses(adapter_path: str, model_keys, rename) -> int:
    """Refuse an adapter whose tensors address none of the transformer's weights.

    This is the failure #6512 calls out: `apply_loras` reports nothing when a
    key does not match — every delta is simply absent, the fusion is a silent
    no-op, and the render is the un-adapted base model dressed as an upscale.
    Only headers are read, so the check costs no tensor I/O and runs BEFORE the
    pipeline loads anything.

    Returns the number of weights the adapter will actually fuse into, so the
    render records real coverage instead of "it loaded".
    """
    header = read_safetensors_header(adapter_path)
    if not header:
        raise SystemExit(
            f"Could not read the adapter's safetensors header at {adapter_path} — "
            "the file is truncated or is not a safetensors weight. Repair it in Video Gen."
        )
    if not model_keys:
        raise SystemExit(
            "Could not read the LTX-2.5 transformer's weight names, so there is no way to tell whether "
            "the upscale adapter would fuse into anything. Repair the model in Video Gen."
        )
    renamed = [rename(name) for name in header if name != "__metadata__"]
    matched = lora_target_keys(name for name in renamed if name) & set(model_keys)
    if not matched:
        raise SystemExit(
            "The upscale adapter's tensors do not address any weight in this transformer, so fusing it "
            "would be a no-op and the 'upscale' would be an un-adapted render. The adapter and the "
            "LTX-2.5 pack are mismatched — repair both in Video Gen."
        )
    return len(matched)


def main() -> None:
    args = parse_args()
    validate_host(platform.system(), platform.machine())
    validate_args(args)
    model_dir = validate_model_dir(args.model)

    header = read_safetensors_header(args.ic_lora_path)
    scale = reference_downscale_factor(header)
    assert_reference_scale_fits(scale, args.width, args.height)
    # Recorded rather than guessed: `icLoraWeights.js` holds `null` for this
    # gated weight precisely because nobody had opened it, and this line is the
    # measurement (#6508's registry note points here).
    log(f"UPSCALE_REFERENCE_DOWNSCALE:{scale}")

    log("STAGE:verify-adapter")
    from ltx_core_mlx.loader import LTXV_LORA_COMFY_RENAMING_MAP
    from ltx_pipelines_mlx.ic_lora import ICLoraPipeline

    emit_runtime_fingerprint("ltx25", FINGERPRINT_PACKAGES)

    # Both sides of the coverage check are header reads, so a mismatched pair
    # fails in milliseconds — before Gemma, before the DiT, before a GPU. Do NOT
    # move this behind a `pipe.load()`: `generate()` deliberately loads the text
    # encoder, encodes, frees it, and only THEN loads the transformer, so
    # pre-loading would hold a multi-GB DiT resident through prompt encoding.
    transformer_path = resolve_transformer_path(model_dir)
    if transformer_path is None:
        raise SystemExit(
            f"The LTX-2.5 pack at {model_dir} has no transformer weight file. Repair the model in Video Gen."
        )
    fused = assert_adapter_fuses(
        args.ic_lora_path,
        transformer_weight_keys(transformer_path),
        LTXV_LORA_COMFY_RENAMING_MAP.apply_to_key,
    )
    log(f"STATUS:Adapter fuses into {fused} transformer weights")

    log("STAGE:load-pipeline")
    log(f"STATUS:Loading LTX-2.5 MLX upscale pipeline ({args.width}x{args.height}, {args.num_frames} frames)")
    pipe = ICLoraPipeline(model_dir=str(model_dir), lora_paths=[(args.ic_lora_path, 1.0)])

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    log("STAGE:inference")
    with heartbeat("ltx25-upscale-inference"):
        # No stage step counts: `DISTILLED_SIGMAS` / `STAGE_2_SIGMAS` ARE the
        # distilled schedule (8 + 3), and passing a count would truncate them.
        pipe.generate_and_save(
            prompt=args.prompt,
            output_path=str(output),
            video_conditioning=[(reference, REFERENCE_STRENGTH) for reference in args.ic_reference],
            height=args.height,
            width=args.width,
            num_frames=args.num_frames,
            frame_rate=args.fps,
            seed=args.seed,
        )
    if not output.is_file():
        raise SystemExit(f"The LTX-2.5 upscale completed but did not write {output}.")
    log(f"STATUS:Upscaled {output.name} ({args.width}x{args.height}, {args.num_frames} frames)")


if __name__ == "__main__":
    main()
