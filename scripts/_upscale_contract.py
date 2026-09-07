"""The argv, grid and adapter contract both generative video-upscale runners share.

#6511 promises ONE argument set for both backends: `buildLtxUpscaleArgs()` in
`server/services/videoGen/renderArgs.js` emits a single argv whichever runtime
the plan resolved, and only the interpreter and script path differ. #6512 (MLX)
and #6513 (CUDA) each implement that contract against a different runtime, so a
second copy of it in each runner would be two tables free to drift — exactly the
failure the flag-passed reference bounds already exist to prevent.

What lives here is the part that is genuinely identical: the parser, the model
grid, and the header-only reads of the IC-LoRA adapter. What stays with each
runner is what actually differs — the runtime it imports, the host it gates on,
the pack layout it validates, and the rename maps its own loader fuses through.

Everything here is stdlib-only, deliberately. These are the checks that run
BEFORE a GPU, an MLX wheel, or a 68 GB model pack is committed, which is what
makes the whole contract testable on a machine that has none of them.
"""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

# The LTX-2.5 two-stage grid, mirrored from `LTX_GRID` in
# `server/services/videoGen/upscalePlan.js` and confirmed against both runtimes:
# stage 1 renders at `height // 2` / `width // 2` and the video VAE compresses
# spatially by 32, so the OUTPUT axis must be divisible by 64 (upstream's own
# `assert_resolution(..., is_two_stage=True)` asserts exactly that). Temporal
# compression is 8 and the reference encoder needs a (1 + 8k)-frame input, so
# `frames % 8 == 1` with a floor of 9.
SPATIAL_MULTIPLE = 64
FRAME_MODULUS = 8
FRAME_REMAINDER = 1
MIN_FRAMES = 9

# Stage 1 renders at half the requested output, and it is those halved dims the
# IC encoder divides by `reference_downscale_factor`.
STAGE1_DIVISOR = 2

# The upscale contract carries no prompt (#6511): the source clip is the whole
# conditioning signal, and inventing text steering would push synthesized detail
# toward content the user never asked for. The empty string is the neutral
# choice — the distilled schedule runs no CFG, so the prompt is pure
# conditioning rather than a guidance pole. `--prompt` exists so #6514's
# verification matrix can probe the effect without changing the argv contract.
DEFAULT_PROMPT = ""

# Full reference conditioning: unlike a control/pose IC render, the reference
# here is the picture itself, so there is nothing to attenuate.
REFERENCE_STRENGTH = 1.0

# A real safetensors header is a few KB to low-MB; anything past this is a
# corrupt length we refuse to allocate for. Mirrors the same bound in
# `server/lib/safetensors.js`.
MAX_HEADER_BYTES = 100 * 1024 * 1024

_LORA_HALVES = ("lora_A", "lora_B")


def add_upscale_arguments(parser: argparse.ArgumentParser, *, model_help: str) -> argparse.ArgumentParser:
    """Declare the flags `buildLtxUpscaleArgs()` emits, in one place.

    The pass is an IC-LoRA render whose single reference IS the clip being
    upscaled, which is why the alphabet is the IC one rather than a second
    vocabulary. The reference-count bounds arrive as flags because
    `server/lib/icLoraWeights.js` is the single source of truth across both
    languages — a Python-side default would be a second table free to drift.

    Only `--model`'s help text differs between backends: one names an MLX pack,
    the other a split CUDA snapshot.
    """
    parser.add_argument("--model", required=True, help=model_help)
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
    return parser


def validate_args(args: argparse.Namespace) -> None:
    """Everything checkable before a GPU is committed.

    Both backends refuse the same sources, and both refuse them the same way a
    direct/script caller would hit — so a queue replay, a hand-run helper and
    the route all get one answer. Every refusal is a `SystemExit` string the
    queue surfaces verbatim.
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

    # A path, never a repo id. Both runtimes' LoRA resolvers fall back to a
    # remote fetch for anything that is not an existing file, which for this
    # gated adapter is a 401 deep inside a render — and for any repo, a pull
    # PortOS never announced. The download surface owns every fetch.
    if not Path(args.ic_lora_path).is_file():
        raise SystemExit(
            f"The Pixel Spatial Upscaler adapter is not on disk at {args.ic_lora_path} — "
            "download it from the Video Gen model panel before upscaling."
        )


def read_safetensors_header(path: str) -> "dict | None":
    """Parse a safetensors JSON header with the stdlib alone.

    Deliberately not `safetensors.safe_open`: this runs during validation, in a
    bare interpreter, before any runtime import — which is what keeps the whole
    argument contract testable without an MLX or torch wheel. Returns None for a
    missing, truncated, or non-safetensors file rather than raising, so the
    caller states the refusal in its own words.
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

    Matches `read_lora_reference_downscale_factor` in both runtimes, which is
    what the pipeline uses as the real value. Read here too so the resolution
    rule can be stated BEFORE a multi-minute render commits to it — and so
    PortOS can record the measured factor rather than the `null` its registry
    honestly holds for a gated weight nobody has opened yet.
    """
    metadata = (header or {}).get("__metadata__")
    if not isinstance(metadata, dict):
        return 1
    try:
        scale = int(metadata.get("reference_downscale_factor", 1))
    except (TypeError, ValueError):
        return 1
    return scale if scale >= 1 else 1


def assert_reference_scale_fits(scale: int, width: int, height: int) -> None:
    """Enforce the adapter's own resolution rule on the STAGE-1 dimensions.

    `append_ic_lora_reference_video_conditionings` divides the dims it is HANDED
    by the factor, and both pipelines hand it `height // 2` / `width // 2`.
    Stating the rule in OUTPUT terms is what makes the message actionable — the
    user picked an output size, not a stage size.
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


def lora_target_keys(names) -> "set[str]":
    """Base-weight keys an adapter can fuse into, from its ALREADY-RENAMED names.

    Both loaders pair `<prefix>.lora_A.weight` with `<prefix>.lora_B.weight` and
    skip a prefix missing either half (`_products_for_sd_key` on torch,
    `_prepare_deltas` on MLX), so a half-pair contributes nothing and must not
    count as coverage. Takes renamed names rather than raw ones on purpose: the
    ComfyUI rename table belongs to the runtime, and copying it here would be a
    second table free to drift from the one that actually fuses.
    """
    prefixes = {half: set() for half in _LORA_HALVES}
    for name in names:
        for half, bucket in prefixes.items():
            suffix = f".{half}.weight"
            if isinstance(name, str) and name.endswith(suffix):
                bucket.add(name[: -len(suffix)])
    return {f"{prefix}.weight" for prefix in prefixes["lora_A"] & prefixes["lora_B"]}


def entry_shape(entry) -> "tuple[int, ...] | None":
    """One safetensors header entry's tensor shape, or None when it has no usable one.

    Total on purpose: a header is untrusted input read before any runtime
    validates it, so a malformed entry yields None and the caller decides
    whether that is a refusal or simply a key it does not care about.
    """
    shape = entry.get("shape") if isinstance(entry, dict) else None
    if not isinstance(shape, list) or not all(isinstance(n, int) for n in shape):
        return None
    return tuple(shape)


def lora_delta_shapes(header: "dict | None", rename) -> "dict[str, tuple[int, int, int, int]]":
    """Per-target `(out_features, in_features, rank_a, rank_b)` for each fusable pair.

    A safetensors header carries every tensor's shape, so the delta `B @ A` a
    fusion would produce is fully described without reading one byte of tensor
    data. That is what lets a runner check an adapter NUMERICALLY — against the
    weights it claims to address — rather than settling for "the load raised
    nothing", which on both runtimes it never would.

    `rename` is the runtime's own key mapping; a key it rejects yields None and
    is dropped, exactly as the loader drops it.
    """
    renamed = {}
    for raw, entry in (header or {}).items():
        if raw == "__metadata__":
            continue
        name = rename(raw)
        if isinstance(name, str):
            renamed[name] = entry
    shapes = {}
    for target in lora_target_keys(renamed):
        prefix = target[: -len(".weight")]
        a = entry_shape(renamed.get(f"{prefix}.lora_A.weight"))
        b = entry_shape(renamed.get(f"{prefix}.lora_B.weight"))
        if a is None or b is None or len(a) != 2 or len(b) != 2:
            continue
        shapes[target] = (b[0], a[1], a[0], b[1])
    return shapes
