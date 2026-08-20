#!/usr/bin/env python3
"""PortOS bridge to dgrauet/ltx-2-mlx pipelines.

Translates the PortOS spawn-protocol used by `mlx_video.generate_av` into the
dgrauet `ltx_pipelines_mlx` Python API. Lives in the ltx-2-mlx venv (see
scripts/setup-image-video.sh INSTALL_LTX2 path) and is invoked by the Node
videoGen service when the selected model has `runtime: 'ltx2'` in
data/media-models.json.

Why a wrapper at all (vs. spawning `ltx-2-mlx <subcommand>` directly):
  - The dgrauet CLI uses bare `print(...)` and `tqdm` for progress; PortOS's
    queue dispatcher parses `STAGE:`, `STATUS:`, `DOWNLOAD:` prefixed lines
    out of stderr to drive SSE. We translate by emitting our prefixes around
    pipeline boundaries (load_models / encode / denoise / decode / save).
  - PortOS already has FFLF / extend / image / text mode semantics that map
    to different pipeline classes here. Putting the dispatch in Python keeps
    the Node side simple — one helper, four subcommands, identical contract
    to the existing `python -m mlx_video.generate_av` invocation.

Modes (class names shown new→old; we resolve whichever the installed pin has):
  text   → TI2VidOneStagePipeline / TextToVideoPipeline .generate_and_save
  image  → TI2VidOneStagePipeline / ImageToVideoPipeline .generate_and_save (--image)
  fflf   → KeyframeInterpolationPipeline.generate_and_save (--image start, --last-image end)
  extend → RetakePipeline / ExtendPipeline .extend_from_video (--extend-from-video, --extend-frames, --direction)
  a2v    → A2VidPipelineTwoStage / AudioToVideoPipeline .generate_and_save (--audio, optional --image)
  ic     → ICLoraPipeline.generate_and_save (--ic-mode, --ic-lora-path, --ic-reference)

IC-LoRA remix modes (--mode ic):
  The IC ("In-Context") pipeline conditions generation on a *reference video*
  channel (VideoConditionByReferenceLatent) with a per-mode IC-LoRA fused into
  the Stage-1 transformer. One pipeline class, several capabilities selected by
  which IC-LoRA weight you fuse — so `--ic-mode` is a label PortOS carries for
  logging/validation, not a different code path. `control` drives structure and
  motion from a depth/pose/edge clip; future modes (ingredients, colorize) reuse
  the same runner with a different weight and reference count.

Pin compatibility — class renames + frame_rate:
  The v0.14.x line of ltx-2-mlx renamed every public pipeline class and
  switched the output-rate keyword from `fps` to `frame_rate`. PortOS pins a
  specific commit (see scripts/setup-image-video.sh LTX2_PIN), but installs
  upgrade on their own schedule, so this bridge resolves both the pipeline
  class (_resolve_pipeline) and the rate keyword (_rate_kwargs) from the live
  API — old and new pins both work.

Output: writes the rendered .mp4 to --output. Emits a final JSON line on
stdout ({"video_path": "<output>"}) so the Node parent can read the result
metadata, mirroring the contract used by mlx_video.generate_av.

Exit strategy — os._exit(0) in main():
  At LTX2 pins past the upstream May-9 refactor, Metal command-buffer
  completion handlers hold the GIL through CPython frame teardown, stalling
  every Distilled/Extend/two-stage render 5-15 min after "Decoding done".
  The .mp4 is already on disk and stdout flushed before we exit, so skipping
  the normal deallocator teardown is safe and saves up to 15 min per render.
"""
from __future__ import annotations

import argparse
import functools
import importlib
import inspect
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import NoReturn

DISTILLED_LORA_25 = "ltx-2.5-22b-distilled-lora-450.safetensors"
DISTILLED_LORA_V11 = "ltx-2.3-22b-distilled-lora-384-1.1.safetensors"
DISTILLED_LORA_LEGACY = "ltx-2.3-22b-distilled-lora-384.safetensors"

# Must be set BEFORE any ltx_core_mlx import: ltx_core_mlx.model.transformer.model
# reads LTX2_DIT_EVAL_EVERY at import time. Phosphene's M4 Max 64 GB I2V Balanced
# 5s / 121 f matrix: upstream default =8 runs ~3 min/step (per-block Metal
# command-buffer churn); =1 runs ~7 s/step (~25× faster denoise); =0 is also
# fast but extends the post-decode deallocator hang. =1 wins on both axes.
# setdefault lets a caller-supplied env var override.
os.environ.setdefault("LTX2_DIT_EVAL_EVERY", "1")
os.environ.setdefault("LTX2_GEMMA_EVAL_EVERY", "1")

# Sibling import: parse_user_loras is shared with generate_av_lora.py (the
# mlx_video LoRA runtime) so the strict --user-loras validation lives in one
# place. sys.path[0] is already this dir when run as a script; insert defensively
# (mirrors generate_hunyuan.py). _runner_common is stdlib-only at import time, so
# this is safe from the ltx-2-mlx venv (no torch pulled in).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import emit_runtime_fingerprint, parse_user_loras  # noqa: E402


def emit_status(msg: str) -> None:
    """STATUS: line — single status update routed to PortOS SSE as `status`."""
    print(f"STATUS:{msg}", file=sys.stderr, flush=True)


def emit_stage(stage: int, step: int, total: int, label: str) -> None:
    """STAGE: line — structured progress, parsed as `progress` (step/total) by PortOS."""
    print(f"STAGE:{stage}:STEP:{step}:{total}:{label}", file=sys.stderr, flush=True)


def emit_download(msg: str) -> None:
    """DOWNLOAD: line — first-use HF download status routed to SSE as `status`."""
    print(f"DOWNLOAD:{msg}", file=sys.stderr, flush=True)


def _resolve_pipeline(*names: str, method: str | None = None):
    """Return the first available pipeline class from ltx_pipelines_mlx.

    LTX-2 renamed every public pipeline class in the v0.14.x line
    (TextToVideoPipeline → TI2VidOneStagePipeline, TwoStagePipeline →
    TI2VidTwoStagesPipeline, AudioToVideoPipeline → A2VidPipelineTwoStage, …).
    We try the names in preference order — new name first, legacy name as
    fallback — so this bridge works against both the v0.14.x pins new installs
    get AND the pre-rename pins an existing install may still have checked out
    until it re-runs setup-image-video.sh.

    `method`, when given, additionally requires the class to define it — used by
    the extend path, where pre-rename pins expose ExtendPipeline.extend_from_video
    and v0.14.x folds that into RetakePipeline.extend_from_video (deleting the
    `extend` module). Preferring whichever class actually defines the method
    avoids selecting a same-named class that happens to lack it.

    Raises a clear SystemExit instead of surfacing an opaque ImportError deep
    inside a runner.
    """
    pkg = importlib.import_module("ltx_pipelines_mlx")
    for name in names:
        cls = getattr(pkg, name, None)
        if cls is not None and (method is None or hasattr(cls, method)):
            return cls
    want = f"pipeline with .{method}()" if method else "expected pipelines"
    raise SystemExit(
        f"ltx-2-mlx exposes no {want} among {names!r} — the installed pin may "
        "be too old or too new for this bridge."
    )


def _first_module_with_attr(attr: str, *modnames: str):
    """Return the first importable module exposing `attr`, or None.

    Best-effort sibling to _resolve_pipeline for module-level symbols: the
    extend denoise loop lives in `extend` on pre-rename pins and in `retake` on
    v0.14.x. Unlike _resolve_pipeline this returns None instead of raising —
    callers treat a miss as "feature unavailable at this pin" and degrade.
    """
    for modname in modnames:
        try:
            mod = importlib.import_module(modname)
        except ImportError:
            continue
        if hasattr(mod, attr):
            return mod
    return None


def _rate_kwarg_name(func) -> str | None:
    """Which output frame-rate keyword `func` accepts: 'frame_rate', 'fps', or None.

    v0.14.x renamed the output-rate parameter from `fps` to `frame_rate` across
    generate_and_save / _decode_and_save_video. Inspecting the live signature
    lets one call site feed either API. Only an *explicit* parameter counts — a
    bare **kwargs is not treated as accepting the rate, so we never smuggle an
    unknown keyword through.
    """
    try:
        params = inspect.signature(func).parameters
    except (TypeError, ValueError):
        return None
    if "frame_rate" in params:
        return "frame_rate"
    if "fps" in params:
        return "fps"
    return None


def _rate_kwargs(func, fps: float) -> dict:
    """Return {<rate-keyword>: fps} for `func`, or {} if it takes neither.

    New pins require `frame_rate` on generate_and_save (keyword-only, no
    default), so passing it is mandatory there; old pins where the rate is
    bound via bind_output_fps instead return {} and rely on that wrapper.
    """
    name = _rate_kwarg_name(func)
    return {name: fps} if name else {}


def _bind_combined_image_conditioning_rate(module, fps: float):
    """Supply frame_rate for the v0.14.x A2V caller that omits it.

    ltx-pipelines-mlx 0.14.8 made ``combined_image_conditionings.frame_rate``
    mandatory, but its two-stage A2V pipeline still calls that helper twice
    without the new keyword when an input image is present. Patch the imported
    orchestration helper for this render only. Pins whose helper predates the
    parameter are left untouched; already-correct callers may still pass their
    own rate and win over this default.
    """
    original = getattr(module, "combined_image_conditionings", None)
    if original is None:
        return lambda: None
    try:
        has_frame_rate = "frame_rate" in inspect.signature(original).parameters
    except (TypeError, ValueError):
        has_frame_rate = False
    if not has_frame_rate:
        return lambda: None

    def combined_image_conditionings_with_rate(*args, **kwargs):
        kwargs.setdefault("frame_rate", fps)
        return original(*args, **kwargs)

    module.combined_image_conditionings = combined_image_conditionings_with_rate
    return lambda: setattr(module, "combined_image_conditionings", original)


def _patch_a2v_image_conditioning_rate(fps: float):
    try:
        orchestration = importlib.import_module("ltx_pipelines_mlx.utils._orchestration")
    except ImportError:
        return lambda: None
    return _bind_combined_image_conditioning_rate(orchestration, fps)


def _import_image_conditioning_input():
    """v0.14.x ImageConditioningInput (per-image strength field), or None on old pins.

    Pre-rename pins have no ltx_pipelines_mlx.utils.args module; image strength
    there is injected via the legacy VideoConditionByLatentIndex monkey-patch
    instead (see _image_conditioning_kwargs / _apply_legacy_image_strength).
    """
    try:
        from ltx_pipelines_mlx.utils.args import ImageConditioningInput
    except ImportError:
        return None
    return ImageConditioningInput


_EXTEND_TC_CONFIG: dict | None = None
_A2V_TC_CONFIG: dict | None = None
_EXTEND_TC_PATCH_OK = False
_A2V_TC_PATCH_OK = False


def _install_guided_denoise_teacache_patches() -> None:
    """Wire TeaCache into the Extend and A2V Stage-1 denoise loops.

    The extend pipeline and `A2VidPipelineTwoStage` (ltx_pipelines_mlx.
    a2vid_two_stage) each `from ...samplers import guided_denoise_loop` into
    their OWN module namespace and call it without a `teacache=` argument. We
    must patch the symbol on *those exact modules* — patching any other module
    leaves the real call site untouched and silently no-ops. We then activate
    the controller only while the matching runner has a per-call config set.

    The extend denoise loop lives in different modules across pins: pre-rename
    pins call it from `ltx_pipelines_mlx.extend`; v0.14.x deletes that module
    and the extend path runs through `ltx_pipelines_mlx.retake`. We resolve
    whichever module actually exposes `guided_denoise_loop` (preferring `extend`
    so pre-rename behavior is unchanged), matching how run_extend resolves
    ExtendPipeline before RetakePipeline.
    """
    global _EXTEND_TC_PATCH_OK, _A2V_TC_PATCH_OK
    try:
        import ltx_pipelines_mlx.a2vid_two_stage as a2v_mod
        from ltx_pipelines_mlx.ti2vid_two_stages import (
            _build_teacache_controller as build_stage1_teacache,
        )
    except Exception:
        return

    extend_mod = _first_module_with_attr(
        "guided_denoise_loop",
        "ltx_pipelines_mlx.extend",
        "ltx_pipelines_mlx.retake",
    )
    if extend_mod is None:
        return

    original_extend_guided_denoise_loop = extend_mod.guided_denoise_loop
    original_a2v_guided_denoise_loop = a2v_mod.guided_denoise_loop

    def build_controller(config: dict | None, fallback_steps: int, sigmas):
        if not config or not config.get("enable"):
            return None
        # `sigmas` carries num_steps+1 values, so len(sigmas)-1 is the real
        # step count. fallback_steps (the pipeline's native Stage-1 default)
        # only applies if a caller ever omits sigmas.
        n_steps = len(sigmas) - 1 if sigmas is not None else config.get("num_steps", fallback_steps)
        try:
            # thresh=None lets _build_teacache_controller apply its own
            # LTX2_TEACACHE_THRESH default (0.5 at the current pin).
            return build_stage1_teacache(n_steps, config.get("thresh"))
        except Exception:
            return None

    def guided_denoise_loop_with_extend_teacache(*args, teacache=None, **kwargs):
        if teacache is None:
            teacache = build_controller(_EXTEND_TC_CONFIG, 30, kwargs.get("sigmas"))
        return original_extend_guided_denoise_loop(*args, teacache=teacache, **kwargs)

    def guided_denoise_loop_with_a2v_teacache(*args, teacache=None, **kwargs):
        if teacache is None:
            teacache = build_controller(_A2V_TC_CONFIG, 30, kwargs.get("sigmas"))
        return original_a2v_guided_denoise_loop(*args, teacache=teacache, **kwargs)

    extend_mod.guided_denoise_loop = guided_denoise_loop_with_extend_teacache
    a2v_mod.guided_denoise_loop = guided_denoise_loop_with_a2v_teacache
    _EXTEND_TC_PATCH_OK = True
    _A2V_TC_PATCH_OK = True


_install_guided_denoise_teacache_patches()


def _teacache_config(enabled: bool, patch_ok: bool, num_steps: int,
                     thresh: float | None = None) -> dict:
    return {
        "enable": bool(enabled) and patch_ok,
        "thresh": thresh,
        "num_steps": num_steps,
    }


def _teacache_thresh_label(thresh: float | None) -> str:
    return f"{thresh}" if thresh is not None else "upstream default 0.5"


def configure_negative_prompt(negative_prompt: str) -> None:
    """Thread PortOS' negative prompt into ltx-2-mlx's CFG encoder.

    The dgrauet pipeline APIs don't expose `negative_prompt` on every public
    generate method. Internally, all text/video/audio pipelines read
    DEFAULT_NEGATIVE_PROMPT at call time. Post-May-9 upstream refactor the
    constant lives in up to three places:
      - ltx_pipelines_mlx.ti2vid_one_stage  (T2V / I2V / A2V one-stage paths)
      - ltx_pipelines_mlx._base             (base class used by Q8/HQ paths)
      - ltx_pipelines_mlx.utils.constants  (two-stage / extend shared import)
      - ltx_core_mlx.utils.constants       (older upstream layouts)

    We overwrite it on every module that already defines it (REPLACE semantics,
    not append). Modules absent at the current LTX2 pin are skipped silently.
    """
    if not negative_prompt:
        return

    _candidates = [
        ("ltx_pipelines_mlx", "ti2vid_one_stage"),
        ("ltx_pipelines_mlx", "_base"),
        ("ltx_pipelines_mlx.utils", "constants"),
        ("ltx_core_mlx.utils", "constants"),
    ]
    patched = 0
    for pkg, mod in _candidates:
        try:
            m = importlib.import_module(f"{pkg}.{mod}")
        except ImportError:
            continue
        if hasattr(m, "DEFAULT_NEGATIVE_PROMPT"):
            m.DEFAULT_NEGATIVE_PROMPT = negative_prompt
            patched += 1

    if patched:
        emit_status("Using custom negative prompt")


# Boundary markers bracketing the Gemma prompt encode. PortOS reads these off
# stderr (generateVideoHelpers.js) to tell a render that died INSIDE the encoder
# from one that died in the denoise loop — only the former is worth relaunching
# with a smaller prompt budget. Kept as module constants so the shape is
# assertable from the test suite rather than duplicated as literals.
PROMPT_ENCODE_BEGIN_MARKER = "STAGE:encode-prompt"
PROMPT_ENCODE_END_MARKER = "STAGE:encode-prompt-done"


def configure_gemma_max_length(max_length: int | None) -> None:
    """Pin the Gemma prompt-encode sequence length for this run.

    ltx-2-mlx reads ``LTX2_GEMMA_MAX_LENGTH`` at encode time
    (``ltx_pipelines_mlx.utils.blocks.PromptEncoder.encode``, and again in
    ``_base`` for Prompt Relay token ranges), defaulting to 1024. PortOS passes a
    lowered value on its one-shot relaunch after the macOS Metal command-buffer
    watchdog aborts the encoder, so this ASSIGNS rather than ``setdefault``s: an
    explicit flag has to beat whatever the parent environment already carried.

    No-op when the flag is absent, which leaves upstream's own default in force.
    """
    if max_length is None:
        return
    if max_length < 1:
        raise SystemExit(f"--gemma-max-length must be a positive integer; got {max_length}.")
    os.environ["LTX2_GEMMA_MAX_LENGTH"] = str(max_length)
    emit_status(f"Gemma prompt-encode capped at {max_length} tokens")


def install_prompt_encode_markers() -> None:
    """Bracket every Gemma prompt encode with the two STAGE: markers.

    ``PromptEncoder.encode`` is the single chokepoint every mode's prompt
    conditioning routes through (``__call__`` fans out to it for both the single
    and batched shapes), so patching it on the CLASS covers text/image/fflf/
    extend/a2v/ic without touching a runner. Same shape as
    ``install_ltx25_encoder_override`` above, and idempotent via the marker
    attribute so a double install can't nest the brackets.

    The end marker means "control left the encoder", not "the encode succeeded":
    it is emitted from ``finally``, so a Python-level encode failure also clears
    the phase. That biases PortOS AWAY from relaunching, which is the safe
    direction — a hard Metal abort kills the process outright, so ``finally``
    never runs and the phase correctly stays open.

    Silently skipped on a pin that does not expose ``PromptEncoder``; PortOS then
    simply never sees an encode phase and never arms the retry.
    """
    try:
        from ltx_pipelines_mlx.utils.blocks import PromptEncoder
    except ImportError:
        return

    original = getattr(PromptEncoder, "encode", None)
    if original is None or getattr(original, "_portos_prompt_encode_markers", False):
        return

    @functools.wraps(original)
    def encode(self, *args, **kwargs):
        print(PROMPT_ENCODE_BEGIN_MARKER, file=sys.stderr, flush=True)
        try:
            return original(self, *args, **kwargs)
        finally:
            print(PROMPT_ENCODE_END_MARKER, file=sys.stderr, flush=True)

    encode._portos_prompt_encode_markers = True
    PromptEncoder.encode = encode


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="PortOS ltx-2-mlx bridge")
    p.add_argument("--mode", required=True, choices=["text", "image", "fflf", "extend", "a2v", "ic"])
    p.add_argument("--prompt", required=True)
    p.add_argument("--negative-prompt", default="")
    p.add_argument("--output", required=True, help="Output .mp4 path")
    p.add_argument("--model", required=True, help="HF repo id or local path (e.g. dgrauet/ltx-2.3-mlx-q4)")
    p.add_argument("--gemma", default=None,
                   help="Shared Gemma repo for LTX-2.3. Omit on LTX-2.5 packs that "
                        "ship Gemma 4 under text_encoder/.")
    p.add_argument("--text-encoder-id",
                   help="id of the substituted LTX-2.5 prompt conditioner (shim directory name)")
    p.add_argument("--text-encoder-file", action="append", default=[],
                   help="an already-cached file of the substitute — shards, the shard index and the "
                        "tokenizer/generation configs (repeatable; the whole pinned set)")
    p.add_argument("--text-encoder-shim-root",
                   help="directory the composed conditioner root is built under")
    p.add_argument("--text-encoder-config-json", default=None,
                   help="JSON object merged over the substitute's own config.json in the shim "
                        "(e.g. {\"model_type\": \"gemma4\"} for a unified checkpoint)")
    p.add_argument("--height", type=int, default=480)
    p.add_argument("--width", type=int, default=704)
    p.add_argument("--num-frames", type=int, default=97)
    p.add_argument("--fps", type=float, default=24.0)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--steps", type=int, default=None,
                   help="One-stage steps; for fflf this maps to stage1-steps")
    p.add_argument("--stage2-steps", type=int, default=None)
    p.add_argument("--cfg-scale", type=float, default=None)
    p.add_argument("--image-strength", type=float, default=None,
                   help="First-frame conditioning strength for image mode (0.0-1.0).")
    p.add_argument("--dev-transformer", default=None,
                   help="Filename of the non-distilled (dev) transformer inside the model repo. "
                        "Required for fflf mode — KeyframeInterpolationPipeline rejects pure-distilled "
                        "models because they hallucinate unrelated content during interpolation. "
                        "Default for fflf: transformer-dev.safetensors (matches dgrauet/ltx-2.3-mlx-q4 + q8 layouts).")
    p.add_argument("--distilled-lora", default=None,
                   help="Filename of the distilled LoRA inside the model repo, fused on top of the "
                        "dev transformer for stage 2. By default PortOS prefers the 1.1 adapter "
                        "when the selected model includes it, otherwise it uses the legacy adapter.")
    p.add_argument("--lora-strength", type=float, default=1.0,
                   help="Distilled-LoRA fusion strength (default 1.0, matches dgrauet's CLI).")
    p.add_argument("--user-loras", default=None,
                   help="JSON list of {path, strength} dicts — user LoRAs (e.g. a "
                        "fal LTX-2.3 LoRA) fused into the transformer via the pipeline's "
                        "_pending_loras hook, the same mechanism upstream's "
                        "`ltx-2-mlx generate --lora <path> <strength>` uses. Works across "
                        "all modes (text/image/fflf/extend/a2v) because every pipeline "
                        "loads its DiT through _load_transformer_with_optional_streaming.")
    p.add_argument("--image", default=None, help="Source/start frame (image, fflf modes)")
    p.add_argument("--last-image", default=None, help="End frame (fflf mode)")
    p.add_argument("--keyframes-json", default=None,
                   help="Multi-keyframe interpolation: JSON-encoded list of {path,index} dicts "
                        "(length >= 2, indices strictly ascending in [0, num_frames-1]). When "
                        "set, fflf mode uses these instead of --image/--last-image — unlocks "
                        "N>2 keyframes for cross-shot continuity, character anchoring, etc.")
    p.add_argument("--extend-from-video", default=None, help="Source video path (extend mode)")
    p.add_argument("--extend-frames", type=int, default=2,
                   help="Number of latent frames to add (extend mode); 1 latent ≈ 8 pixel frames")
    p.add_argument("--extend-direction", choices=["before", "after"], default="after")
    p.add_argument("--audio", default=None, help="Source audio path (a2v mode) — WAV/MP3/etc.")
    p.add_argument("--audio-start", type=float, default=0.0,
                   help="Start offset in seconds into the audio file (a2v mode).")
    p.add_argument("--no-audio", action="store_true",
                   help="Strip audio from output. The dgrauet pipeline always generates A/V; "
                        "we re-mux without the audio stream when requested.")
    p.add_argument("--ic-mode", default=None,
                   help="IC-LoRA remix flavor label for --mode ic (e.g. control). Names which "
                        "capability the fused IC-LoRA provides; used for logging only — the "
                        "pipeline itself is identical across flavors, and the real per-mode rules "
                        "arrive as the flags below. Free-form so PortOS' registry, not this "
                        "helper, decides which flavors exist.")
    p.add_argument("--ic-lora-path", default=None,
                   help="IC-LoRA weight for --mode ic: a local .safetensors path OR a HuggingFace "
                        "repo id (ICLoraPipeline resolves a repo id via snapshot_download). "
                        "Required for ic mode — PortOS resolves the per-mode default on the Node "
                        "side so the weight registry lives in one place.")
    p.add_argument("--ic-reference", action="append", default=None, metavar="PATH",
                   help="Reference clip for the IC-LoRA video-conditioning channel. Repeatable; "
                        "how many the fused weight expects is set by --ic-min/max-references.")
    # NO DEFAULTS. A 1/1 default would silently green-light a direct
    # `--ic-mode ingredients --ic-reference one.mp4` invocation that omitted the
    # flags: the wrong reference count for a weight yields plausible-looking
    # garbage rather than an error, so "caller forgot the bounds" must fail loudly
    # instead of falling back to some other weight's contract. Required together.
    p.add_argument("--ic-min-references", type=int, default=None,
                   help="Fewest --ic-reference entries the fused weight accepts (from PortOS' "
                        "icLoraWeights registry, which owns the per-weight contract). REQUIRED "
                        "for --mode ic, alongside --ic-max-references.")
    p.add_argument("--ic-max-references", type=int, default=None,
                   help="Most --ic-reference entries the fused weight accepts. REQUIRED for "
                        "--mode ic, alongside --ic-min-references.")
    p.add_argument("--ic-strength", type=float, default=1.0,
                   help="Per-reference conditioning strength (0.0-1.0+) applied to every "
                        "--ic-reference entry.")
    p.add_argument("--ic-attention-strength", type=float, default=None,
                   help="IC-LoRA conditioning ATTENTION strength in [0.0, 1.0] — 0 ignores the "
                        "reference entirely, 1 is full conditioning. Omit for the pipeline default.")
    p.add_argument("--ic-skip-stage-2", action="store_true",
                   help="Skip the IC-LoRA pipeline's 2x upscale + refine pass (half-resolution "
                        "output, roughly half the wall time).")
    p.add_argument("--no-teacache", action="store_true",
                   help="Disable TeaCache acceleration for supported LTX-2 denoise loops "
                        "(extend and a2v Stage 1).")
    p.add_argument("--teacache-thresh", type=float, default=None,
                   help="rel_l1_thresh for TeaCache on extend/a2v Stage 1. Higher = more "
                        "skipping = faster but lower fidelity (~1.2x at 0.5, up to ~3x at 1.5). "
                        "Omit to use the pipeline default (0.5).")
    p.add_argument("--gemma-max-length", type=int, default=None,
                   help="Gemma prompt-encode sequence length (LTX2_GEMMA_MAX_LENGTH; "
                        "upstream default 1024). PortOS lowers this on its one-shot "
                        "relaunch after the macOS Metal command-buffer watchdog aborts "
                        "the prompt encoder. An explicit value always wins over the "
                        "ambient environment.")
    return p.parse_args()


def parse_text_encoder_config_overrides(raw: str | None) -> dict:
    """Parse `--text-encoder-config-json` into the dict merged over the shim config."""
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"--text-encoder-config-json must be valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise SystemExit(
            f"--text-encoder-config-json must be a JSON object; got {type(parsed).__name__}."
        )
    return parsed


def validate_text_encoder_args(args: argparse.Namespace) -> None:
    """Reject a partial substitution set before any weights load.

    All-or-nothing, mirroring generate_minimax_h3.py: without the id there is
    nowhere to build the shim, and without the shim root there is nowhere to put
    it. Accepting a partial set would silently fall back to the conditioner
    packed in the model and hand the user a render they'd have no way to tell
    apart from a substituted one.
    """
    encoder_flags = (args.text_encoder_id, args.text_encoder_file, args.text_encoder_shim_root)
    if any(encoder_flags) and not all(encoder_flags):
        raise SystemExit(
            "--text-encoder-id, --text-encoder-file and --text-encoder-shim-root must be given together."
        )
    if args.text_encoder_id and not re.fullmatch(r"[A-Za-z0-9._-]+", args.text_encoder_id):
        raise SystemExit(f"--text-encoder-id must be a bare directory-safe name; got {args.text_encoder_id!r}.")
    if not args.text_encoder_file and args.text_encoder_config_json:
        raise SystemExit("--text-encoder-config-json needs --text-encoder-file.")
    # A substitution and the 2.3 shared encoder are mutually exclusive: --gemma
    # is only read when the pack ships no local gemma4 tower, which is exactly
    # the case where the override below has nothing to replace.
    if args.text_encoder_file and args.gemma:
        raise SystemExit("--text-encoder-file substitutes an LTX-2.5 pack's own conditioner; --gemma cannot apply.")
    parse_text_encoder_config_overrides(args.text_encoder_config_json)


def build_ltx25_encoder_shim(
    shim_root: Path,
    encoder_id: str,
    encoder_files: list[Path],
    config_overrides: dict,
) -> Path:
    """Compose a standalone Gemma 4 checkpoint directory from the substitute.

    Unlike the MiniMax H3 shim next door — which links an upstream checkpoint
    root through and swaps only `text_encoder/` — everything here comes from the
    substitute: mlx-lm loads a Gemma 4 tower from one self-describing directory,
    and the LTX-2.5 pack contributes only its connector, which is loaded
    separately and never sees this path.

    Every pinned file is linked in under its own basename: the shards, the
    `model.safetensors.index.json` that names them, and the tokenizer /
    generation configs. Only `config.json` is generated, because two things must
    change before `Gemma4LanguageModel.load()` will accept it — `model_type`
    (a unified checkpoint publishes `gemma4_unified`, which that loader
    hard-rejects) and the `vision_config` / `audio_config` blocks, dropped so
    what remains matches what the fork's own converter emits. The substitute's
    `quantization` block is copied verbatim: its per-layer group-size overrides
    are part of how the weights were packed, and a mismatch dequantizes to noise.

    Rebuilt from scratch on every render — the links are free, and a stale shim
    pointing at a blob the user has since re-downloaded would otherwise load
    silently-wrong weights.
    """
    for encoder_file in encoder_files:
        if not encoder_file.is_file():
            raise RuntimeError(f"Substituted text encoder is missing: {encoder_file}")
    names = [f.name for f in encoder_files]
    if len(set(names)) != len(names):
        raise RuntimeError(f"Substituted text encoder has duplicate file names: {sorted(names)}")
    source_config = next((f for f in encoder_files if f.name == "config.json"), None)
    if source_config is None:
        raise RuntimeError("Substituted text encoder must pin its own config.json.")

    root = shim_root / encoder_id
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True, exist_ok=True)

    for encoder_file in encoder_files:
        # config.json is generated below, not linked: linking it through would
        # hand the loader the very `model_type` the override exists to correct.
        if encoder_file.name != "config.json":
            (root / encoder_file.name).symlink_to(encoder_file)

    config = json.loads(source_config.read_text(encoding="utf-8"))
    config.pop("vision_config", None)
    config.pop("audio_config", None)
    config.update(config_overrides)
    (root / "config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")

    return root


def filter_ltx25_unified_weights(weights: dict) -> dict:
    """Drop the unified checkpoint's residual visual-only tensors.

    mlx-lm's Gemma 4 sanitizer already removes ``vision_tower.*``,
    ``audio_tower.*`` and the multimodal projectors before strict weight
    loading.  The pinned Heretic unified checkpoints additionally publish ten
    or eleven ``vision_embedder.*`` tensors (sometimes under a leading
    ``model.``),
    which are not part of the text-only ``gemma4`` module tree and otherwise
    make strict loading fail.  Filter only that proven visual prefix: using
    ``strict=False`` would also hide a genuinely missing language tensor.
    """
    return {
        key: value
        for key, value in weights.items()
        if not key.removeprefix("model.").startswith("vision_embedder.")
    }


def install_ltx25_unified_weight_filter() -> None:
    """Extend mlx-lm's Gemma 4 sanitizer for the pinned unified candidate.

    Installed only for an explicit LTX-2.5 substitution and before the model
    loads.  Mark the wrapper so a process that installs the adapter twice does
    not stack it; normal PortOS renders install it once and then ``os._exit``.
    """
    from mlx_lm.models.gemma4 import Model

    original = Model.sanitize
    if getattr(original, "_portos_ltx25_unified_filter", False):
        return

    def sanitize(self, weights):
        return original(self, filter_ltx25_unified_weights(weights))

    sanitize._portos_ltx25_unified_filter = True
    Model.sanitize = sanitize


def install_ltx25_encoder_override(shim_dir: Path) -> None:
    """Point the pack's conditioner resolution at the shim, for every pipeline.

    ``PromptEncoder._text_encoder_source`` prefers a local ``text_encoder/``
    reporting ``model_type: "gemma4"`` unconditionally and ignores
    ``gemma_model_id``, so a substitution has to override that method rather than
    pass an argument. Patched on the CLASS — not on a constructed pipeline — so
    it cannot be skipped by a mode that builds its pipeline differently, or by a
    mode added later. This is the same shape as
    ``generate_minimax_h3.install_key_prefix_map``.

    The wrapped original still resolves the encoder CLASS, so nothing here has to
    import ``Gemma4LanguageModel`` from a path the pinned fork could move — and a
    pack that does NOT resolve to it (an LTX-2.3 model dir reached through this
    flag) fails loudly instead of conditioning on the wrong architecture.
    """
    from ltx_pipelines_mlx.utils.blocks import PromptEncoder

    original = PromptEncoder._text_encoder_source

    def _text_encoder_source(self):
        _, encoder_class = original(self)
        if encoder_class.__name__ != "Gemma4LanguageModel":
            raise RuntimeError(
                "A substituted text encoder needs an LTX-2.5 pack whose own conditioner is gemma4; "
                f"this model dir resolves to {encoder_class.__name__}."
            )
        return str(shim_dir), encoder_class

    PromptEncoder._text_encoder_source = _text_encoder_source


def _apply_user_loras(pipe, specs: list[tuple[str, float]]) -> None:
    """Set the pipeline's _pending_loras hook so user-LoRA deltas fuse into the
    transformer at load time.

    The DiT loads lazily inside generate_and_save (via
    _load_transformer_with_optional_streaming, which reads _pending_loras and
    fuses the deltas before quantization), so setting it on the constructed
    pipe — before the generate call — is sufficient. This is the exact
    mechanism the upstream `ltx-2-mlx generate --lora` CLI uses, and it works
    across every mode because all pipelines route DiT construction through that
    one method. No-op when no user LoRAs were requested.
    """
    if not specs:
        return
    pipe._pending_loras = list(specs)
    names = ", ".join(f"{Path(p).name}@{s:g}" for p, s in specs)
    emit_status(f"Fusing {len(specs)} user LoRA(s): {names}")


def bind_output_fps(pipe, fps: float) -> None:
    """Make pipeline _decode_and_save_video() calls decode at the requested rate.

    The output-rate keyword is `frame_rate` on v0.14.x pins and `fps` on
    pre-rename pins; we bind whichever the live method accepts. We inject the
    rate only when the caller hasn't already supplied it, so a generate_and_save
    that threads `frame_rate=` through to the decoder internally isn't
    double-set.
    """
    decode_and_save = pipe._decode_and_save_video
    rate_name = _rate_kwarg_name(decode_and_save)

    def decode_with_fps(video_latent, audio_latent, output_path, **kwargs):
        if rate_name and rate_name not in kwargs:
            kwargs[rate_name] = fps
        return decode_and_save(video_latent, audio_latent, output_path, **kwargs)

    pipe._decode_and_save_video = decode_with_fps


def _apply_legacy_image_strength(image_strength: float) -> bool:
    """Inject I2V strength on pre-rename pins; return True if the hook applied.

    Pre-rename pins drive first-frame conditioning through a module-level
    `VideoConditionByLatentIndex` symbol on ti2vid_one_stage (and ti2vid_two_stages)
    that we subclass to bake in the strength — replaced wholesale, not appended.
    v0.14.x reworked image conditioning and no longer exposes that hook (strength
    is carried by ImageConditioningInput instead — see _image_conditioning_kwargs),
    so this returns False there and the caller surfaces a clear notice.
    """
    from ltx_pipelines_mlx import ti2vid_one_stage
    if not hasattr(ti2vid_one_stage, "VideoConditionByLatentIndex"):
        return False

    from ltx_core_mlx.conditioning.types.latent_cond import VideoConditionByLatentIndex as BaseCondition

    class PortOSVideoCondition(BaseCondition):
        def __init__(self, frame_indices, clean_latent, strength=1.0):
            super().__init__(frame_indices, clean_latent, strength=image_strength)

    ti2vid_one_stage.VideoConditionByLatentIndex = PortOSVideoCondition
    try:
        from ltx_pipelines_mlx import ti2vid_two_stages
        if hasattr(ti2vid_two_stages, "VideoConditionByLatentIndex"):
            ti2vid_two_stages.VideoConditionByLatentIndex = PortOSVideoCondition
    except ImportError:
        pass
    return True


def _image_conditioning_kwargs(generate_and_save, image: str | None,
                               image_strength: float | None) -> dict:
    """I2V image kwarg(s) for generate_and_save, honoring --image-strength on both pins.

    Returns {} when there's no source image. With no strength override we pass a
    bare `image=` on every pin — unchanged behavior. With a strength override:

      - v0.14.x carries per-image strength as a first-class field on
        ImageConditioningInput passed through `images=[...]` (passing
        `images=[ImageConditioningInput(path, 0, 1.0)]` is exactly what the
        pipeline builds from a bare `image=` internally, so this only changes
        the strength); and
      - pre-rename pins take a bare `image=` and get strength from the legacy
        VideoConditionByLatentIndex monkey-patch, applied here just before
        generate reads it. If even that hook is absent we surface a notice and
        fall back to the pipeline default rather than silently dropping it.

    Pin selection is by the live API: the new path needs both an `images`
    parameter on generate_and_save AND an importable ImageConditioningInput.
    """
    if not image:
        return {}
    if image_strength is None:
        return {"image": image}
    if image_strength < 0.0 or image_strength > 1.0:
        raise SystemExit("--image-strength must be between 0.0 and 1.0")

    ImageConditioningInput = _import_image_conditioning_input()
    if ImageConditioningInput is not None and \
            "images" in inspect.signature(generate_and_save).parameters:
        emit_status(f"Using image strength {image_strength:g}")
        return {"images": [ImageConditioningInput(
            path=image, frame_idx=0, strength=image_strength,
        )]}

    if _apply_legacy_image_strength(image_strength):
        emit_status(f"Using image strength {image_strength:g}")
    else:
        emit_status(
            "--image-strength not supported at this ltx-2-mlx pin "
            "(reworked image conditioning) — using pipeline default"
        )
    return {"image": image}


def _one_stage_kwargs(args: argparse.Namespace, **extra) -> dict:
    """Shared generate_and_save kwargs for the one-stage text/image runners.

    Omits num_steps when --steps is unset so each pin applies its own default —
    the new TI2VidOneStagePipeline types num_steps as a non-optional int and
    would choke on an explicit None.
    """
    kwargs: dict = dict(
        prompt=args.prompt,
        output_path=args.output,
        height=args.height,
        width=args.width,
        num_frames=args.num_frames,
        seed=args.seed,
        **extra,
    )
    if args.steps is not None:
        kwargs["num_steps"] = args.steps
    return kwargs


def _prefer_distilled_lora(pipe, requested: str | None) -> str:
    """Select the newest compatible distilled adapter already in model_dir.

    BasePipeline resolves a HuggingFace repo ID to its cached snapshot during
    construction, but does not load the transformer until generate_and_save().
    That gives the bridge a safe point to prefer the 1.1 adapter without
    making a separate Hub metadata request. Repositories that do not carry 1.1
    keep using the legacy file; an explicit CLI value always wins.
    """
    selected = requested
    if selected is None:
        selected = next(
            (
                filename
                for filename in (DISTILLED_LORA_25, DISTILLED_LORA_V11, DISTILLED_LORA_LEGACY)
                if (Path(pipe.model_dir) / filename).exists()
            ),
            DISTILLED_LORA_LEGACY,
        )
    pipe._distilled_lora = selected
    emit_status(f"Using distilled adapter {selected}")
    return selected


def _gemma_kwargs(args: argparse.Namespace) -> dict:
    """LTX-2.5 packs ship Gemma 4 under text_encoder/; omit the 2.3 shared encoder."""
    if args.gemma:
        return {"gemma_model_id": args.gemma}
    return {}


def run_two_stage(args: argparse.Namespace, image: str | None = None) -> str:
    """T2V/I2V path that honors CFG via the dgrauet two-stage pipeline."""
    TwoStagePipeline = _resolve_pipeline("TI2VidTwoStagesPipeline", "TwoStagePipeline")
    emit_status(f"Loading two-stage pipeline ({args.model})…")
    emit_stage(1, 0, 1, "Loading model")
    pipe = TwoStagePipeline(
        model_dir=args.model,
        dev_transformer=args.dev_transformer or "transformer-dev.safetensors",
        distilled_lora=args.distilled_lora or DISTILLED_LORA_LEGACY,
        distilled_lora_strength=args.lora_strength,
        **_gemma_kwargs(args),
    )
    _prefer_distilled_lora(pipe, args.distilled_lora)
    _apply_user_loras(pipe, args.user_lora_specs)
    bind_output_fps(pipe, args.fps)
    emit_stage(1, 1, 1, "Loaded")
    emit_status("Generating with CFG…")
    return pipe.generate_and_save(
        prompt=args.prompt,
        output_path=args.output,
        height=args.height,
        width=args.width,
        num_frames=args.num_frames,
        seed=args.seed,
        stage1_steps=args.steps if args.steps is not None else 30,
        stage2_steps=args.stage2_steps,
        cfg_scale=args.cfg_scale if args.cfg_scale is not None else 3.0,
        **_image_conditioning_kwargs(pipe.generate_and_save, image, args.image_strength),
        **_rate_kwargs(pipe.generate_and_save, args.fps),
    )


def run_text(args: argparse.Namespace) -> str:
    if args.cfg_scale is not None:
        return run_two_stage(args)
    OneStagePipeline = _resolve_pipeline("TI2VidOneStagePipeline", "TextToVideoPipeline")
    emit_status(f"Loading T2V pipeline ({args.model})…")
    emit_stage(1, 0, 1, "Loading model")
    pipe = OneStagePipeline(model_dir=args.model, **_gemma_kwargs(args))
    _apply_user_loras(pipe, args.user_lora_specs)
    bind_output_fps(pipe, args.fps)
    emit_stage(1, 1, 1, "Loaded")
    emit_status("Generating T2V…")
    return pipe.generate_and_save(
        **_one_stage_kwargs(args),
        **_rate_kwargs(pipe.generate_and_save, args.fps),
    )


def run_image(args: argparse.Namespace) -> str:
    if not args.image:
        raise SystemExit("--image is required for image mode")
    # --image-strength is threaded into generate_and_save via
    # _image_conditioning_kwargs (per-pipe, since the new/old pins carry it
    # differently); both the two-stage and one-stage paths below pick it up.
    if args.cfg_scale is not None:
        return run_two_stage(args, image=args.image)
    OneStagePipeline = _resolve_pipeline("TI2VidOneStagePipeline", "ImageToVideoPipeline")
    emit_status(f"Loading I2V pipeline ({args.model})…")
    emit_stage(1, 0, 1, "Loading model")
    pipe = OneStagePipeline(model_dir=args.model, **_gemma_kwargs(args))
    _apply_user_loras(pipe, args.user_lora_specs)
    bind_output_fps(pipe, args.fps)
    emit_stage(1, 1, 1, "Loaded")
    emit_status("Generating I2V…")
    image_kwargs = _image_conditioning_kwargs(
        pipe.generate_and_save, args.image, args.image_strength
    )
    return pipe.generate_and_save(
        **_one_stage_kwargs(args, **image_kwargs),
        **_rate_kwargs(pipe.generate_and_save, args.fps),
    )


def _resolve_keyframes(args: argparse.Namespace) -> tuple[list[str], list[int]]:
    """Decide between multi-keyframe (--keyframes-json) and legacy 2-keyframe.

    Multi-keyframe wins when --keyframes-json is non-empty. Validation is
    strict so agent bugs surface here before any GPU work.
    """
    last_pixel_frame = args.num_frames - 1
    if args.keyframes_json:
        try:
            raw = json.loads(args.keyframes_json)
        except json.JSONDecodeError as e:
            raise SystemExit(f"--keyframes-json is not valid JSON: {e}")
        if not isinstance(raw, list) or len(raw) < 2:
            raise SystemExit("--keyframes-json must be a list of length >= 2")
        images: list[str] = []
        indices: list[int] = []
        for i, kf in enumerate(raw):
            if not isinstance(kf, dict) or "path" not in kf or "index" not in kf:
                raise SystemExit(f"keyframe[{i}] must be an object with 'path' and 'index'")
            path = kf["path"]
            idx = kf["index"]
            if not isinstance(path, str) or not path:
                raise SystemExit(f"keyframe[{i}].path must be a non-empty string")
            if not isinstance(idx, int) or isinstance(idx, bool):
                raise SystemExit(f"keyframe[{i}].index must be an int")
            if not Path(path).exists():
                raise SystemExit(f"keyframe[{i}].path does not exist: {path}")
            if idx < 0 or idx > last_pixel_frame:
                raise SystemExit(
                    f"keyframe[{i}].index {idx} out of range [0, {last_pixel_frame}]"
                )
            if indices and idx <= indices[-1]:
                raise SystemExit(
                    f"keyframe indices must be strictly ascending; got {indices[-1]} then {idx}"
                )
            images.append(path)
            indices.append(idx)
        return images, indices
    if not args.image or not args.last_image:
        raise SystemExit(
            "fflf mode requires either --keyframes-json or both --image and --last-image"
        )
    return [args.image, args.last_image], [0, last_pixel_frame]


def run_fflf(args: argparse.Namespace) -> str:
    """Keyframe interpolation — N keyframes at arbitrary frame indices.

    Pixel frame indices map to LTX's latent grid; num_frames must be 8k+1
    (LTX latent boundary) — the panel UI enforces this via FRAME_OPTIONS.

    Two callers:
      - Legacy FFLF (--image start, --last-image end at [0, num_frames-1])
      - Multi-keyframe (--keyframes-json with N>=2 anchor points). Agent SDK
        uses this for character continuity, cross-shot anchoring, and
        compositional control.
    """
    KeyframeInterpolationPipeline = _resolve_pipeline("KeyframeInterpolationPipeline")
    keyframe_images, keyframe_indices = _resolve_keyframes(args)
    # Keyframe interpolation needs the dev (non-distilled) transformer +
    # the distilled LoRA fused on top for stage 2. Defaults match the file
    # names in dgrauet/ltx-2.3-mlx-q4 and dgrauet/ltx-2.3-mlx-q8 — caller
    # can override via --dev-transformer / --distilled-lora when a future
    # repo renames them.
    dev_transformer = args.dev_transformer or "transformer-dev.safetensors"
    distilled_lora = args.distilled_lora or DISTILLED_LORA_LEGACY
    emit_status(f"Loading Keyframe pipeline ({args.model}, dev+lora)…")
    emit_stage(1, 0, 1, "Loading model")
    pipe = KeyframeInterpolationPipeline(
        model_dir=args.model,
        dev_transformer=dev_transformer,
        distilled_lora=distilled_lora,
        distilled_lora_strength=args.lora_strength,
        **_gemma_kwargs(args),
    )
    _prefer_distilled_lora(pipe, args.distilled_lora)
    _apply_user_loras(pipe, args.user_lora_specs)
    emit_stage(1, 1, 1, "Loaded")
    emit_status(f"Interpolating between {len(keyframe_images)} keyframes at indices {keyframe_indices}…")
    return pipe.generate_and_save(
        prompt=args.prompt,
        output_path=args.output,
        keyframe_images=keyframe_images,
        keyframe_indices=keyframe_indices,
        height=args.height,
        width=args.width,
        num_frames=args.num_frames,
        seed=args.seed,
        stage1_steps=args.steps,
        stage2_steps=args.stage2_steps,
        cfg_scale=args.cfg_scale if args.cfg_scale is not None else 3.0,
        **_rate_kwargs(pipe.generate_and_save, args.fps),
    )


def run_extend(args: argparse.Namespace) -> str:
    """Extend an existing video by N latent frames (1 latent ≈ 8 pixel frames).
    Conditions on the entire source video's latent — motion AND visual content
    flow into the new frames. Mirrors dgrauet's CLI `_cmd_extend` memory pattern:
    free DiT + text encoder before decode (otherwise OOMs at the VAE pass).
    """
    global _EXTEND_TC_CONFIG
    from ltx_core_mlx.utils.memory import aggressive_cleanup
    # v0.14.x: RetakePipeline.extend_from_video; pre-rename pins: ExtendPipeline.
    # New name first (the resolver contract) — and on the old pin RetakePipeline
    # lacks extend_from_video, so method-presence still selects ExtendPipeline.
    ExtendPipeline = _resolve_pipeline(
        "RetakePipeline", "ExtendPipeline", method="extend_from_video"
    )
    if not args.extend_from_video:
        raise SystemExit("--extend-from-video is required for extend mode")
    emit_status(f"Loading Extend pipeline ({args.model})…")
    emit_stage(1, 0, 1, "Loading model")
    pipe = ExtendPipeline(model_dir=args.model, **_gemma_kwargs(args))
    _apply_user_loras(pipe, args.user_lora_specs)
    emit_stage(1, 1, 1, "Loaded")
    emit_status(f"Extending video {args.extend_direction} by {args.extend_frames} latent frames…")
    num_steps = args.steps if args.steps is not None else 30
    _EXTEND_TC_CONFIG = _teacache_config(not args.no_teacache, _EXTEND_TC_PATCH_OK, num_steps,
                                         args.teacache_thresh)
    if _EXTEND_TC_CONFIG["enable"]:
        emit_status(f"TeaCache active on extend (thresh={_teacache_thresh_label(args.teacache_thresh)})")
    try:
        video_latent, audio_latent = pipe.extend_from_video(
            prompt=args.prompt,
            video_path=args.extend_from_video,
            extend_frames=args.extend_frames,
            direction=args.extend_direction,
            seed=args.seed,
            num_steps=num_steps,
            cfg_scale=args.cfg_scale if args.cfg_scale is not None else 3.0,
        )
    finally:
        _EXTEND_TC_CONFIG = None
    # Mirror cli._decode_and_save: drop the DiT + text encoder before the VAE
    # decode — otherwise full-res decode + the still-resident transformer OOMs
    # the unified-memory budget. Then load_decoders() pulls the VAE back in
    # on demand.
    if pipe.low_memory:
        pipe.dit = None
        pipe.text_encoder = None
        pipe.feature_extractor = None
        pipe._loaded = False
        aggressive_cleanup()
    pipe._load_decoders()
    bind_output_fps(pipe, args.fps)
    return pipe._decode_and_save_video(video_latent, audio_latent, args.output)


def run_a2v(args: argparse.Namespace) -> str:
    """Audio-to-video — generate a clip whose motion + audio track sync to an
    input WAV/MP3. Two-stage pipeline (dev model + CFG at half-res, then
    distilled-LoRA refine at full-res), so it shares the same dev_transformer +
    distilled_lora layout as fflf — a fully-distilled-only repo will fail
    here for the same reason it fails for fflf.

    The pipeline always emits A/V; --no-audio re-muxes after to drop audio,
    but doing that for a2v is unusual (the audio is the conditioning input).
    --image is optional: when provided, conditions the FIRST frame the same
    way ImageToVideoPipeline does, so motion + audio sync to a chosen still.
    """
    global _A2V_TC_CONFIG
    AudioToVideoPipeline = _resolve_pipeline("A2VidPipelineTwoStage", "AudioToVideoPipeline")
    if not args.audio:
        raise SystemExit("--audio is required for a2v mode")
    emit_status(f"Loading A2V pipeline ({args.model})…")
    emit_stage(1, 0, 1, "Loading model")
    pipe = AudioToVideoPipeline(model_dir=args.model, **_gemma_kwargs(args))
    _prefer_distilled_lora(pipe, args.distilled_lora)
    _apply_user_loras(pipe, args.user_lora_specs)
    emit_stage(1, 1, 1, "Loaded")
    emit_status(f"Generating A2V from {Path(args.audio).name}…")
    stage1_steps = args.steps if args.steps is not None else 30
    _A2V_TC_CONFIG = _teacache_config(not args.no_teacache, _A2V_TC_PATCH_OK, stage1_steps,
                                      args.teacache_thresh)
    if _A2V_TC_CONFIG["enable"]:
        emit_status(f"TeaCache active on A2V Stage 1 (thresh={_teacache_thresh_label(args.teacache_thresh)})")
    restore_image_rate = _patch_a2v_image_conditioning_rate(args.fps)
    try:
        return pipe.generate_and_save(
            prompt=args.prompt,
            output_path=args.output,
            audio_path=args.audio,
            image=args.image,
            height=args.height,
            width=args.width,
            num_frames=args.num_frames,
            seed=args.seed,
            stage1_steps=stage1_steps,
            stage2_steps=args.stage2_steps,
            cfg_scale=args.cfg_scale if args.cfg_scale is not None else 3.0,
            audio_start_time=args.audio_start,
            **_rate_kwargs(pipe.generate_and_save, args.fps),
        )
    finally:
        restore_image_rate()
        _A2V_TC_CONFIG = None


def run_ic_lora(args: argparse.Namespace) -> str:
    """IC-LoRA reference-conditioned generation (control / ingredients / colorize).

    ICLoraPipeline is a two-stage distilled pipeline whose Stage 1 fuses an
    IC-LoRA and appends the reference clip(s) as VideoConditionByReferenceLatent
    tokens; Stage 2 reloads a clean transformer and refines at 2x. The flavor
    (control/ingredients/colorize) is entirely a function of WHICH IC-LoRA
    weight is fused — same class, same call — so `--ic-mode` only drives
    validation + status prose here.

    Notes:
      - `--ic-lora-path` may be a local .safetensors OR an HF repo id; the
        pipeline's own _resolve_lora_path handles the download. PortOS normally
        pre-fetches the weight through its HF-cache surface so the pull shows up
        with progress instead of stalling silently mid-render.
      - `reference_downscale_factor` is read off the LoRA's safetensors metadata
        by the pipeline (Union-Control ships 2, halving the reference clip), and
        it requires height/width divisible by that factor. A mismatch raises
        inside the pipeline; we surface the resolution rule in the error so the
        user knows to nudge the dimensions rather than the reference.
      - User LoRAs stack ON TOP of the IC-LoRA rather than replacing it: the
        IC-LoRA rides `lora_paths` (fused by _fuse_loras before Stage 1) while
        user LoRAs ride the separate `_pending_loras` hook, so an
        Ingredients x Character stack composes.
      - Ingredients is MULTI-reference (2-8) and conditions on stills, but the
        reference channel is a video encoder end-to-end: iclora_utils probes each
        reference with ffprobe and feeds it to the video VAE, whose reshape needs
        a (1 + 8k)-frame input. PortOS therefore materializes each still into a
        tiny 9-frame constant clip before invoking this helper, so `--ic-reference`
        is uniformly a video path regardless of the weight's reference kind.
    """
    ICLoraPipeline = _resolve_pipeline("ICLoraPipeline")
    ic_mode = args.ic_mode or "control"
    if not args.ic_lora_path:
        raise SystemExit("--ic-lora-path is required for ic mode")
    references = list(args.ic_reference or [])
    # Bounds come from the caller (PortOS' icLoraWeights registry owns them) so
    # this helper never carries a second table that can drift. Enforced anyway:
    # a weight fed the wrong reference count produces plausible-looking garbage
    # rather than an error, so a direct/script caller needs the guard too.
    lo, hi = args.ic_min_references, args.ic_max_references
    if lo is None or hi is None:
        raise SystemExit(
            "--ic-min-references and --ic-max-references are both required for ic mode "
            "(they carry the fused weight's reference contract; guessing them would let a "
            "wrong reference count render plausible-looking garbage)"
        )
    if lo < 1 or hi < lo:
        raise SystemExit(
            f"--ic-min-references/--ic-max-references must satisfy 1 <= min <= max; got {lo}/{hi}"
        )
    if not (lo <= len(references) <= hi):
        expected = f"exactly {lo}" if lo == hi else f"{lo}-{hi}"
        raise SystemExit(
            f"--ic-mode {ic_mode} needs {expected} --ic-reference clip(s); got {len(references)}"
        )
    for ref in references:
        if not Path(ref).exists():
            raise SystemExit(f"--ic-reference does not exist: {ref}")
    if args.ic_attention_strength is not None and not (0.0 <= args.ic_attention_strength <= 1.0):
        raise SystemExit("--ic-attention-strength must be between 0.0 and 1.0")

    emit_status(f"Loading IC-LoRA pipeline ({args.model}, {ic_mode})…")
    emit_stage(1, 0, 1, "Loading model")
    pipe = ICLoraPipeline(
        model_dir=args.model,
        # Fusion strength 1.0 — the IC-LoRA is the mode, not a stylistic dial, so
        # PortOS exposes no knob for it (the user-facing dial is --ic-strength,
        # which weights the reference conditioning). Upstream's CLI defaults the
        # same way.
        lora_paths=[(args.ic_lora_path, 1.0)],
        **_gemma_kwargs(args),
    )
    # User LoRAs go through _pending_loras (fused at DiT load), NOT lora_paths —
    # so they stack with the IC-LoRA above instead of displacing it.
    _apply_user_loras(pipe, args.user_lora_specs)
    bind_output_fps(pipe, args.fps)
    emit_stage(1, 1, 1, "Loaded")
    ref_names = ", ".join(Path(r).name for r in references)
    emit_status(f"Generating IC-LoRA {ic_mode} from {ref_names} (strength {args.ic_strength:g})…")
    kwargs: dict = dict(
        prompt=args.prompt,
        output_path=args.output,
        video_conditioning=[(ref, args.ic_strength) for ref in references],
        height=args.height,
        width=args.width,
        num_frames=args.num_frames,
        seed=args.seed,
        stage1_steps=args.steps,
        stage2_steps=args.stage2_steps,
        skip_stage_2=args.ic_skip_stage_2,
        **_rate_kwargs(pipe.generate_and_save, args.fps),
    )
    if args.ic_attention_strength is not None:
        kwargs["conditioning_attention_strength"] = args.ic_attention_strength
    return pipe.generate_and_save(**kwargs)


def maybe_strip_audio(output_path: str) -> None:
    """Remux the output without the audio stream when --no-audio is set.

    Caller already wrote `<output_path>` containing both video + audio; we
    swap it for a video-only mp4 in place. ffmpeg's `-an` drops the audio
    stream, `-c:v copy` skips re-encoding so this is fast and lossless.
    """
    import shutil
    import subprocess
    import tempfile
    if not Path(output_path).exists():
        return
    if not shutil.which("ffmpeg"):
        emit_status("ffmpeg not on PATH — leaving audio in output despite --no-audio")
        return
    fd, tmp = tempfile.mkstemp(suffix=".mp4", dir=os.path.dirname(output_path))
    os.close(fd)
    try:
        proc = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", output_path, "-c:v", "copy", "-an", tmp],
            check=False,
        )
        if proc.returncode == 0 and Path(tmp).stat().st_size > 0:
            os.replace(tmp, output_path)
            emit_status("Stripped audio (--no-audio)")
        else:
            os.unlink(tmp)
            emit_status(f"ffmpeg audio-strip failed (exit {proc.returncode}); keeping A/V")
    except OSError as e:
        emit_status(f"ffmpeg audio-strip skipped: {e}")


def main() -> NoReturn:
    args = parse_args()
    validate_text_encoder_args(args)
    # One-line runtime fingerprint at startup — captured by PortOS onto the
    # render record so garbled output can be tied to a specific ltx/mlx stack.
    emit_runtime_fingerprint("ltx2", ["ltx_pipelines_mlx", "ltx_core_mlx", "mlx", "mlx_metal"])
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    # Substituted LTX-2.5 prompt conditioner (#4320). Installed BEFORE any
    # runner builds its pipeline, so every mode picks it up from the class.
    if args.text_encoder_file:
        # Bare phase marker plus a separate STATUS line: the SSE parser reads
        # field 2 of a STAGE frame as `step`/`heartbeat`, so the encoder id
        # cannot ride along in the marker itself.
        print("STAGE:swap-text-encoder", file=sys.stderr, flush=True)
        emit_status(f"Conditioning with the {args.text_encoder_id} text encoder")
        install_ltx25_unified_weight_filter()
        install_ltx25_encoder_override(build_ltx25_encoder_shim(
            Path(args.text_encoder_shim_root),
            args.text_encoder_id,
            [Path(f) for f in args.text_encoder_file],
            parse_text_encoder_config_overrides(args.text_encoder_config_json),
        ))
    # Parse user LoRAs once up-front (strict validation surfaces bad input
    # before any model load). Each run_* sets pipe._pending_loras from this.
    args.user_lora_specs = parse_user_loras(args.user_loras)
    configure_negative_prompt(args.negative_prompt)
    configure_gemma_max_length(args.gemma_max_length)
    install_prompt_encode_markers()

    runners = {
        "text": run_text,
        "image": run_image,
        "fflf": run_fflf,
        "extend": run_extend,
        "a2v": run_a2v,
        "ic": run_ic_lora,
    }
    runner = runners[args.mode]
    saved_path = runner(args)
    if args.no_audio:
        maybe_strip_audio(saved_path)

    # Final JSON line on stdout — matches the contract mlx_video.generate_av
    # provides, so videoGen/local.js can pick up `result.video_path` from
    # job.resultJson without a separate parser branch per runtime.
    # flush=True ensures the JSON line reaches Node before os._exit skips
    # CPython teardown (see module docstring for why we avoid normal return).
    print(json.dumps({"video_path": saved_path}), flush=True)
    os._exit(0)


if __name__ == "__main__":
    main()
