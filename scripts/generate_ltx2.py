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
# for direct and imported execution. _runner_common is stdlib-only at import time, so
# this is safe from the ltx-2-mlx venv (no torch pulled in).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import emit_runtime_fingerprint, parse_user_loras, write_stepwise_preview  # noqa: E402


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


# ---------------------------------------------------------------------------
# Speed profiles (#4875)
#
# PortOS picks a named schedule declaratively (server/lib/videoSpeedProfiles.js)
# and hands it here as ordinary --steps/--stage2-steps/--cfg-scale plus the
# levers only this process can check: is the pinned two-stage pipeline new
# enough to accept `enable_teacache`, and is the distilled adapter the schedule
# was measured with actually inside the model pack?
#
# Neither question is fatal. A profile whose TeaCache is unavailable still
# renders at its step schedule — it is just slower than the label promises, and
# THAT is the thing the user must be told rather than left to infer from a
# stopwatch. So each unavailable lever is recorded in `degraded`, announced as a
# STATUS line, and reported to PortOS on a single SPEEDPROFILE: line that the
# history record keeps beside the requested profile id.
# ---------------------------------------------------------------------------

_SPEED_PROFILE_REPORT: dict = {}


def _accepts_kwarg(fn, name: str) -> bool:
    """Does `fn` declare an EXPLICIT keyword parameter called `name`?

    Used to probe the pinned pipeline rather than assume a version.

    Deliberately strict in both directions:
      - a signature that can't be read at all is False, since a wrong True
        means a TypeError mid-render rather than a slow one;
      - a bare `**kwargs` is ALSO False. Such a wrapper would accept the
        argument without erroring, but nothing says it forwards it — and
        reporting `teacache: true` for a render that got no acceleration is
        exactly the misleading speed claim this feature exists to prevent.
        Degrading on an un-introspectable wrapper costs a real speed-up only
        in a case we cannot verify anyway.

    The KIND is checked, not just the name: a positional-only parameter (or a
    `**name` catch-all that happens to be spelled the same) matches by name but
    cannot be passed by keyword, so accepting it would raise TypeError at the
    call — the very outcome the probe exists to avoid.
    """
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    param = params.get(name)
    return param is not None and param.kind in (
        inspect.Parameter.POSITIONAL_OR_KEYWORD,
        inspect.Parameter.KEYWORD_ONLY,
    )


def speed_profile_begin(args: argparse.Namespace) -> None:
    """Start a speed-profile report for this render. No-op without a profile."""
    global _SPEED_PROFILE_REPORT
    if not args.speed_profile:
        _SPEED_PROFILE_REPORT = {}
        return
    _SPEED_PROFILE_REPORT = {
        "id": args.speed_profile,
        "steps": args.steps,
        "stage2Steps": args.stage2_steps,
        "cfgScale": args.cfg_scale,
        "teacache": False,
        "teacacheThresh": args.teacache_thresh,
        "adapter": None,
        "degraded": [],
    }


def speed_profile_degrade(lever: str, message: str) -> None:
    """Record a lever this render could not apply, and say so out loud."""
    if not _SPEED_PROFILE_REPORT:
        return
    if lever not in _SPEED_PROFILE_REPORT["degraded"]:
        _SPEED_PROFILE_REPORT["degraded"].append(lever)
    emit_status(message)


def speed_profile_applied(**fields) -> None:
    """Record levers that DID apply (teacache=True, adapter=<filename>, …)."""
    if not _SPEED_PROFILE_REPORT:
        return
    _SPEED_PROFILE_REPORT.update(fields)


def speed_profile_emit() -> None:
    """Emit the SPEEDPROFILE: line PortOS stamps onto the history record.

    Best-effort, exactly like emit_runtime_fingerprint: a reporting failure
    must never abort a render that is otherwise fine.
    """
    if not _SPEED_PROFILE_REPORT:
        return
    try:
        print(f"SPEEDPROFILE:{json.dumps(_SPEED_PROFILE_REPORT)}", file=sys.stderr, flush=True)
    except Exception as err:  # pragma: no cover - defensive
        print(f"⚠️ speed profile report failed: {err}", file=sys.stderr, flush=True)


def _two_stage_teacache_kwargs(generate_and_save, args: argparse.Namespace) -> dict:
    """TeaCache kwargs for the two-stage pipeline, or {} when unavailable.

    `enable_teacache` landed on `TI2VidTwoStagesPipeline.generate_and_save`
    after the pipelines were renamed; a pre-rename pin has the two-stage path
    but not the kwarg, and passing it there is a TypeError, not a slow render.
    """
    if not args.teacache:
        return {}
    if not _accepts_kwarg(generate_and_save, "enable_teacache"):
        speed_profile_degrade(
            "teacache",
            "TeaCache unavailable at this ltx-2-mlx pin — rendering the profile's "
            "step schedule without cache acceleration (slower than the profile's estimate).",
        )
        return {}
    kwargs = {"enable_teacache": True}
    # `teacache_thresh` is probed SEPARATELY rather than assumed to ride along
    # with `enable_teacache`. A pin that carries one but not the other would
    # raise TypeError on the call — turning a lever we could not apply into a
    # failed render, which is the one outcome this whole path exists to avoid.
    #
    # When the profile declares NO override there is nothing to lose: the kwarg
    # is omitted and the pin applies its own calibrated default (0.5), which is
    # exactly what the profile wanted. But when the profile named a specific
    # threshold and the pin cannot take it, the render samples at a DIFFERENT
    # threshold than the schedule specifies — a partly-applied profile, so it
    # is recorded as degraded rather than reported as a clean full run.
    if args.teacache_thresh is not None:
        if _accepts_kwarg(generate_and_save, "teacache_thresh"):
            kwargs["teacache_thresh"] = args.teacache_thresh
        else:
            speed_profile_applied(teacacheThresh=None)
            speed_profile_degrade(
                "teacacheThresh",
                f"This ltx-2-mlx pin takes no TeaCache threshold override, so the "
                f"profile's {args.teacache_thresh} is not in effect — sampling at the "
                "pin's own calibrated default instead.",
            )
    speed_profile_applied(teacache=True)
    emit_status(
        f"TeaCache active on Stage 1 (thresh={_teacache_thresh_label(kwargs.get('teacache_thresh'))})"
    )
    return kwargs


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
    p.add_argument("--preview-dir", default=None,
                   help="Job-scoped directory where the latest decoded denoise frame is published")
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
    p.add_argument("--i2v-reference-mode", choices=["anchor", "inspire"], default="anchor",
                   help="What --image PROMISES in image mode. 'anchor' (default) pins it as "
                        "frame one, reproducing those pixels; 'inspire' conditions loosely so "
                        "the reference guides subject/style while frame one is generated. "
                        "'inspire' needs a pin whose generate_and_save accepts "
                        "images=[ImageConditioningInput(...)]; the run FAILS rather than "
                        "silently anchoring when it does not.")
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
                   help="rel_l1_thresh for TeaCache on extend/a2v Stage 1, and on the "
                        "two-stage T2V/I2V Stage 1 when --teacache is passed. Higher = more "
                        "skipping = faster but lower fidelity (~1.2x at 0.5, up to ~3x at 1.5). "
                        "Omit to use the pipeline default (0.5).")
    p.add_argument("--speed-profile", default=None,
                   help="Name of the PortOS speed profile driving this render "
                        "(server/lib/videoSpeedProfiles.js). Purely a label: the schedule "
                        "itself arrives as --steps/--stage2-steps/--cfg-scale. Enables the "
                        "SPEEDPROFILE: report naming which levers actually applied.")
    p.add_argument("--teacache", action="store_true",
                   help="Request TeaCache on the two-stage T2V/I2V Stage 1 denoise loop. "
                        "Off by default there (unlike extend/a2v, where it is on unless "
                        "--no-teacache). Degrades with an explicit status when the pinned "
                        "pipeline predates the enable_teacache kwarg.")
    p.add_argument("--require-adapter", default=None,
                   help="Distilled adapter filename this render's speed profile was "
                        "measured with. Reported as degraded (never fatal) when the model "
                        "pack does not carry it, so a slower render is never presented as "
                        "the profile's validated speed.")
    p.add_argument("--gemma-max-length", type=int, default=None,
                   help="Gemma prompt-encode sequence length (LTX2_GEMMA_MAX_LENGTH; "
                        "upstream default 1024). PortOS lowers this on its one-shot "
                        "relaunch after the macOS Metal command-buffer watchdog aborts "
                        "the prompt encoder. An explicit value always wins over the "
                        "ambient environment.")
    p.add_argument("--mlx-cache-limit-mb", default=None,
                   help="Cap the MLX allocator cache at this many MB for the whole run, "
                        "reasserted before every render. Omit to derive a conservative "
                        "ceiling from physical memory. PORTOS_MLX_CACHE_LIMIT_MB sets the "
                        "same knob ambiently; this flag wins over it.")
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


def validate_reference_mode_args(args: argparse.Namespace) -> None:
    """Reject a loose reference on a mode that cannot express one, before any load.

    A loose ("inspire") reference is an image-mode promise. Every other mode pins
    its conditioning by construction — fflf keyframes, extend latents, a2v audio,
    an IC reference clip — so the flag has nothing to loosen there, and accepting
    it would render an anchored clip under a loose-reference label. PortOS gates
    this server-side too; this covers a direct CLI caller.
    """
    if args.i2v_reference_mode != "anchor" and args.mode != "image":
        raise SystemExit(
            f"--i2v-reference-mode {args.i2v_reference_mode} applies to --mode image only; "
            f"got --mode {args.mode}."
        )


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


def _ltx_preview_shapes(args: argparse.Namespace) -> list[tuple[int, int, int]]:
    """Return the one-stage and two-stage latent shapes this pin may denoise.

    The LTX sampler carries packed video rows rather than a 5-D latent. The
    pipeline's own shape helper is the compatibility boundary for both the
    pre-rename and v0.14.x pins, so the preview hook never hardcodes the
    temporal or spatial compression factors.
    """
    try:
        from ltx_core_mlx.components.patchifiers import compute_video_latent_shape
    except ImportError:
        return []

    try:
        from ltx_core_mlx.components.patchifiers import snap_output_dimensions
    except ImportError:
        # Older checked-out pins do not expose the convenience snapper. Their
        # public latent-shape helper still accepts snapped dimensions, and the
        # server's video dimensions are already multiples of 64 in practice.
        snap_output_dimensions = lambda height, width, two_stage: (height, width)

    one_h, one_w = snap_output_dimensions(args.height, args.width, two_stage=False)
    full_h, full_w = snap_output_dimensions(args.height, args.width, two_stage=True)
    dimensions = ((one_h, one_w), (full_h // 2, full_w // 2), (full_h, full_w))
    shapes = []
    seen = set()
    for height, width in dimensions:
        shape = compute_video_latent_shape(args.num_frames, height, width)
        if shape not in seen:
            seen.add(shape)
            shapes.append(shape)
    return shapes


def _install_ltx_stepwise_preview(pipe, args: argparse.Namespace):
    """Tap the installed LTX sampler after each video denoise step.

    ``ltx-pipelines-mlx`` has no stable public callback on the versions PortOS
    supports. Its sampler does, however, call the module-local ``euler_step``
    once for video and once for audio. Wrapping that narrow primitive keeps the
    bridge source-pinned and lets us project the packed video rows back through
    the pipeline's own patchifier and decoder. Preview failures are deliberately
    non-fatal: the final render remains the source of truth.
    """
    preview_dir = getattr(args, "preview_dir", None)
    if not preview_dir:
        return lambda: None
    try:
        import numpy as np
        import mlx.core as mx
        from ltx_pipelines_mlx.utils import samplers
    except ImportError as exc:
        print(f"⚠️ stepwise LTX preview unavailable: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        return lambda: None

    shapes = _ltx_preview_shapes(args)
    if not shapes:
        return lambda: None
    original_euler_step = samplers.euler_step
    state = {"expect_video": True, "saved": 0}

    def shape_for_tokens(token_count: int):
        exact = [(shape[0] * shape[1] * shape[2], shape) for shape in shapes
                 if shape[0] * shape[1] * shape[2] == token_count]
        if exact:
            return exact[0][1]
        # Keyframe conditioning appends rows to the generated video rows. Pick
        # the smallest compatible base shape so the appended rows are not
        # mistaken for a larger two-stage canvas.
        compatible = [(token_count - base, shape) for base, shape in
                      ((shape[0] * shape[1] * shape[2], shape) for shape in shapes)
                      if token_count > base and token_count - base <= base * 4]
        return min(compatible, key=lambda item: item[0])[1] if compatible else None

    def publish(result, shape) -> None:
        stage = "start"
        try:
            frames, latent_height, latent_width = shape
            token_count = frames * latent_height * latent_width
            stage = "eval-sampler-result"
            mx.eval(result)
            tokens = result[:, :token_count, :]
            stage = "unpatchify"
            latent = pipe.video_patchifier.unpatchify(tokens, shape)
            # Decode one temporal latent slice. It is enough to show the
            # forming composition and avoids decoding the entire clip while
            # the DiT is still resident for the next step.
            frame_index = max(0, frames // 2)
            latent = latent[:, :, frame_index:frame_index + 1, :, :]
            stage = "load-decoder"
            decoder_block = getattr(pipe, "video_decoder_block", None)
            if decoder_block is not None and hasattr(decoder_block, "load"):
                decoder = decoder_block.load()
            else:
                decoder = getattr(pipe, "vae_decoder", decoder_block)
            if decoder is None:
                raise RuntimeError("pipeline exposes no video decoder")
            stage = "decode"
            decoded = decoder.decode(latent)
            # Some MLX decoder implementations return bfloat16-backed arrays;
            # normalize before crossing into NumPy, whose buffer bridge does
            # not support that dtype consistently on Apple Silicon.
            decoded = decoded.astype(mx.float32)
            stage = "eval-decoded"
            mx.eval(decoded)
            # MLX exposes a buffer view whose PEP 3118 item size is not
            # consistent for some decoded uint8 tensors. Force a detached
            # NumPy copy at this boundary instead of asking numpy.asarray to
            # consume that view in place.
            stage = "numpy-copy"
            array = np.array(decoded)
            frame = array[0, :, array.shape[2] // 2, :, :].transpose(1, 2, 0)
            frame = np.clip((frame + 1.0) * 127.5, 0, 255).astype("uint8")
            stage = "publish-png"
            if write_stepwise_preview(preview_dir, frame):
                state["saved"] += 1
        except Exception as exc:  # best-effort instrumentation around a live runner
            print(f"⚠️ LTX stepwise preview failed at {stage}: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)

    def euler_step(sample, denoised, sigma, sigma_next):
        result = original_euler_step(sample, denoised, sigma, sigma_next)
        is_video_turn = state["expect_video"]
        state["expect_video"] = not state["expect_video"]
        if not is_video_turn:
            return result
        shape = shape_for_tokens(int(sample.shape[1]))
        if shape is not None:
            publish(result, shape)
        return result

    samplers.euler_step = euler_step

    def restore():
        if samplers.euler_step is euler_step:
            samplers.euler_step = original_euler_step

    return restore


def _run_with_ltx_stepwise_preview(pipe, args: argparse.Namespace, render):
    # Every mode routes its render through here, so this is where the allocator
    # cache ceiling is reasserted: loading weights resets it, and a two-stage or
    # chained job renders more than once inside one process.
    reassert_mlx_cache_policy()
    restore = _install_ltx_stepwise_preview(pipe, args)
    try:
        return render()
    finally:
        restore()


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


# Conditioning strength applied to a loose ("inspire") reference when the caller
# passes no --image-strength. PortOS resolves the same default server-side and
# always sends an explicit value (see lib/videoReferenceModes.js —
# INSPIRE_DEFAULT_IMAGE_STRENGTH is authoritative), so this only covers a direct
# CLI invocation of this script.
INSPIRE_DEFAULT_IMAGE_STRENGTH = 0.35


def _image_conditioning_kwargs(generate_and_save, image: str | None,
                               image_strength: float | None,
                               reference_mode: str = "anchor") -> dict:
    """I2V image kwarg(s) for generate_and_save, honoring --image-strength on both pins.

    `reference_mode` is what the image PROMISES (#4874). "anchor" is the historical
    behavior: the reference is frame one. "inspire" conditions the same frame-0 slot
    at a deliberately low strength so the reference steers subject/style while the
    opening frame is re-generated — the only loose-reference mechanism the MLX
    pipelines expose. Because that mechanism IS the per-image strength field, a pin
    without it cannot honor "inspire" at all; this raises there instead of falling
    back to a bare `image=`, which would anchor the render the user asked NOT to be
    anchored. "anchor" keeps its existing graceful degradation.

    Returns {} when there's no source image. With no strength override and an
    anchored reference we pass a bare `image=` on every pin — unchanged behavior.
    With a strength override (or any loose reference, which always resolves one):

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
    loose = reference_mode == "inspire"
    if image_strength is None and not loose:
        return {"image": image}
    if image_strength is not None and (image_strength < 0.0 or image_strength > 1.0):
        raise SystemExit("--image-strength must be between 0.0 and 1.0")
    strength = INSPIRE_DEFAULT_IMAGE_STRENGTH if image_strength is None else image_strength

    ImageConditioningInput = _import_image_conditioning_input()
    if ImageConditioningInput is not None and \
            "images" in inspect.signature(generate_and_save).parameters:
        emit_status(f"Using {reference_mode} reference at image strength {strength:g}")
        return {"images": [ImageConditioningInput(
            path=image, frame_idx=0, strength=strength,
        )]}

    if loose:
        raise SystemExit(
            "--i2v-reference-mode inspire needs per-image conditioning strength "
            "(ImageConditioningInput), which this ltx-2-mlx pin does not expose. "
            "Re-run with --i2v-reference-mode anchor, or select an LTX-2.5 model."
        )
    if _apply_legacy_image_strength(strength):
        emit_status(f"Using image strength {strength:g}")
    else:
        emit_status(
            "--image-strength not supported at this ltx-2-mlx pin "
            "(reworked image conditioning) — using pipeline default"
        )
    return {"image": image}


# --- I2V anchor preservation across an ancestral (SDE) denoise -----------------
#
# LTX-2.5 samples distilled stage 1 with the ancestral (SDE) Euler loop, which
# renoises the WHOLE latent after every step. The conditioned tokens — the
# frame-0 rows an image-to-video render pins to the supplied picture — live in
# that same latent, so a loop that does not re-apply the conditioning mask AFTER
# the renoise leaves the anchor clean only on the terminal step. The clip that
# comes out is plausible and coherent; it just isn't the picture the user handed
# in, and nothing in the output says so.
#
# PortOS does not own the pin, so the invariant is enforced rather than assumed:
#
#   1. a pin whose own ancestral loop re-applies the mask after the renoise is
#      used as-is ("native");
#   2. a pin that does not gets a clean-room hook at the sampler seam — the same
#      re-application, expressed through the pin's OWN `apply_denoise_mask`, and
#      idempotent, so it cannot fight a loop that already does it ("hook"); and
#   3. a pin that exposes neither is REFUSED before any weights load, because
#      the alternative is silently shipping an unanchored clip.
#
# Scoped to `--mode image`: that is the only mode whose whole promise is "the
# reference IS frame one" (lib/videoReferenceModes.js). T2V has a uniform mask
# and nothing to preserve, and the FFLF/extend/a2v pipelines are left byte-
# identical — this seam is not on their path unless they route through the same
# ancestral loop, which they do not on any pin PortOS ships.


def _import_ancestral_sampler():
    """The installed pin's sampler module, or None when it has no ancestral loop.

    A pin without `ancestral_euler_step` / `ancestral_denoise_loop` never injects
    noise mid-denoise (plain Euler), so the anchor holds by construction and
    there is nothing here to enforce — that is the LTX-2.3 pin, and why this
    returns a sentinel rather than raising.
    """
    try:
        from ltx_pipelines_mlx.utils import samplers
    except ImportError:
        return None
    if not all(hasattr(samplers, name)
               for name in ("ancestral_euler_step", "ancestral_denoise_loop")):
        return None
    return samplers


def _sampler_preserves_conditioned_tokens(samplers) -> bool:
    """Does the pin's own ancestral loop re-apply the mask AFTER the ancestral step?

    Read off the loop's source rather than inferred from a version string,
    because the whole problem is that PortOS does not control which commit is
    checked out. The window starts at the LAST `ancestral_euler_step(` call, so
    the `apply_denoise_mask` every pin runs on x0 *before* the step cannot be
    mistaken for the post-renoise one the invariant needs. A source-less
    sampler (a C extension, a pin shipped as a .pyc) reads as "not proven",
    which routes to the hook rather than to trust.
    """
    try:
        source = inspect.getsource(samplers.ancestral_denoise_loop)
    except (OSError, TypeError):
        return False
    _, marker, tail = source.rpartition("ancestral_euler_step(")
    return bool(marker) and "apply_denoise_mask" in tail


def _install_ancestral_anchor_hook(samplers) -> bool:
    """Clean-room compatibility hook at the sampler seam. True when installed.

    Two module-global wrappers, both inside the pin's own `samplers` module, so
    they take effect no matter which module imported the loop by name:

      - `apply_denoise_mask` — the loop already calls it once per latent per step
        to pin x0 to the clean tokens. Wrapping it RECORDS the (clean, mask) pair
        for each latent; the return value is the pin's own, untouched.
      - `ancestral_euler_step` — after the pin's step (Euler + renoise) returns,
        the recorded pair for that latent is applied again, which is exactly the
        reference `post_process_latent` the broken pins are missing.

    Pairs are keyed by latent SHAPE rather than by call order, so an extra model
    call, a reordered loop, or a pipeline that denoises video only still lands on
    the right mask. Two latents sharing a shape WITHIN one step (video and audio
    of equal token count) is the one case a shape cannot disambiguate, so that
    key is dropped and those steps keep the pin's own behavior — never a wrong
    mask. Restating the same shape in a LATER step is the ordinary case (stage 2
    of a two-stage render rebuilds its latent state) and simply replaces the
    record.
    """
    try:
        from ltx_core_mlx.conditioning.types.latent_cond import apply_denoise_mask
    except ImportError:
        return False
    if getattr(samplers.ancestral_euler_step, "_portos_anchor_hook", False):
        return True

    original_apply = samplers.apply_denoise_mask
    original_step = samplers.ancestral_euler_step
    conditioning: dict = {}
    ambiguous: set = set()
    steps_taken = [0]

    def _key(latent):
        shape = getattr(latent, "shape", None)
        return None if shape is None else tuple(shape)

    @functools.wraps(original_apply)
    def recording_apply_denoise_mask(x0, clean_latent, denoise_mask):
        key = _key(clean_latent)
        if key is not None:
            prior = conditioning.get(key)
            same_step = prior is not None and prior[2] == steps_taken[0]
            if same_step and (prior[0] is not clean_latent or prior[1] is not denoise_mask):
                ambiguous.add(key)
            conditioning[key] = (clean_latent, denoise_mask, steps_taken[0])
        return original_apply(x0, clean_latent, denoise_mask)

    @functools.wraps(original_step)
    def anchor_preserving_ancestral_euler_step(sample, denoised, *args, **kwargs):
        result = original_step(sample, denoised, *args, **kwargs)
        key = _key(sample)
        steps_taken[0] += 1
        if key is None or key in ambiguous:
            return result
        pair = conditioning.get(key)
        if pair is None:
            return result
        clean_latent, denoise_mask = pair[0], pair[1]
        # The step returns float32 while the latent state is held in the model
        # dtype; match the result so the blend does not silently upcast the
        # whole latent. A pin (or a test double) whose arrays carry no dtype
        # skips the cast rather than guessing one.
        dtype = getattr(result, "dtype", None)
        if dtype is not None:
            clean_latent = clean_latent.astype(dtype)
            denoise_mask = denoise_mask.astype(dtype)
        return apply_denoise_mask(result, clean_latent, denoise_mask)

    anchor_preserving_ancestral_euler_step._portos_anchor_hook = True
    samplers.apply_denoise_mask = recording_apply_denoise_mask
    samplers.ancestral_euler_step = anchor_preserving_ancestral_euler_step
    return True


def enforce_i2v_anchor_invariant(args) -> str:
    """Guarantee the frame-0 anchor survives every denoise step, or refuse to render.

    Returns which mechanism is carrying the invariant — "not-required" (no
    ancestral sampler on this pin, or not an anchored I2V render), "native" (the
    pin's own loop), or "hook" (the compatibility hook above). Raises SystemExit
    when the installed pin has the ancestral sampler but can supply neither.

    Called from main() BEFORE any pipeline is constructed, so a refusal costs the
    user a second rather than a full model load.
    """
    if args.mode != "image" or not args.image:
        return "not-required"
    samplers = _import_ancestral_sampler()
    if samplers is None:
        return "not-required"
    if _sampler_preserves_conditioned_tokens(samplers):
        return "native"
    if _install_ancestral_anchor_hook(samplers):
        emit_status("Preserving the frame-one anchor across the ancestral denoise")
        return "hook"
    raise SystemExit(
        "This ltx runtime samples image-to-video with the ancestral (SDE) Euler "
        "loop but neither preserves the conditioned frame across its steps nor "
        "exposes ltx_core_mlx's apply_denoise_mask for PortOS to preserve it — "
        "the render would drift off the supplied image. Re-run "
        "scripts/setup-image-video.sh to restore the pinned LTX-2.5 checkout."
    )


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


def _prefer_distilled_lora(pipe, requested: str | None, required: str | None = None) -> str:
    """Select the newest compatible distilled adapter already in model_dir.

    BasePipeline resolves a HuggingFace repo ID to its cached snapshot during
    construction, but does not load the transformer until generate_and_save().
    That gives the bridge a safe point to prefer the 1.1 adapter without
    making a separate Hub metadata request. Repositories that do not carry 1.1
    keep using the legacy file; an explicit CLI value always wins.

    `required` is the adapter a speed profile's schedule was measured against
    (--require-adapter). Its absence from the pack is NOT fatal — the render
    proceeds on whatever adapter is there — but it is reported as a degraded
    lever so the profile's speed claim isn't presented as if it held.
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
    if required and selected != required:
        speed_profile_degrade(
            "adapter",
            f"Speed profile expects the {required} adapter, which this model pack "
            f"does not carry — rendering with {selected} instead (slower than the "
            "profile's estimate).",
        )
    else:
        speed_profile_applied(adapter=selected)
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
    _prefer_distilled_lora(pipe, args.distilled_lora, args.require_adapter)
    _apply_user_loras(pipe, args.user_lora_specs)
    bind_output_fps(pipe, args.fps)
    emit_stage(1, 1, 1, "Loaded")
    emit_status("Generating with CFG…")
    # Speed-profile TeaCache. Probed against THIS pin's signature rather than
    # assumed, and reported as degraded when the kwarg isn't there — see
    # _two_stage_teacache_kwargs. {} on every non-profile render, so a quality
    # render calls generate_and_save with exactly the arguments it always did.
    teacache_kwargs = _two_stage_teacache_kwargs(pipe.generate_and_save, args)
    return _run_with_ltx_stepwise_preview(pipe, args, lambda: pipe.generate_and_save(
        prompt=args.prompt,
        output_path=args.output,
        height=args.height,
        width=args.width,
        num_frames=args.num_frames,
        seed=args.seed,
        stage1_steps=args.steps if args.steps is not None else 30,
        stage2_steps=args.stage2_steps,
        cfg_scale=args.cfg_scale if args.cfg_scale is not None else 3.0,
        **teacache_kwargs,
        **_image_conditioning_kwargs(pipe.generate_and_save, image, args.image_strength,
                                     args.i2v_reference_mode),
        **_rate_kwargs(pipe.generate_and_save, args.fps),
    ))


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
    return _run_with_ltx_stepwise_preview(pipe, args, lambda: pipe.generate_and_save(
        **_one_stage_kwargs(args),
        **_rate_kwargs(pipe.generate_and_save, args.fps),
    ))


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
        pipe.generate_and_save, args.image, args.image_strength, args.i2v_reference_mode
    )
    return _run_with_ltx_stepwise_preview(pipe, args, lambda: pipe.generate_and_save(
        **_one_stage_kwargs(args, **image_kwargs),
        **_rate_kwargs(pipe.generate_and_save, args.fps),
    ))


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
    return _run_with_ltx_stepwise_preview(pipe, args, lambda: pipe.generate_and_save(
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
    ))


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
        video_latent, audio_latent = _run_with_ltx_stepwise_preview(pipe, args, lambda: pipe.extend_from_video(
            prompt=args.prompt,
            video_path=args.extend_from_video,
            extend_frames=args.extend_frames,
            direction=args.extend_direction,
            seed=args.seed,
            num_steps=num_steps,
            cfg_scale=args.cfg_scale if args.cfg_scale is not None else 3.0,
        ))
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
    # The full-res VAE decode below is this mode's largest allocation, and the
    # cleanup above releases the allocator limit along with the buffers when it
    # runs — so reassert the ceiling before the decoders come back in.
    reassert_mlx_cache_policy()
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
        return _run_with_ltx_stepwise_preview(pipe, args, lambda: pipe.generate_and_save(
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
        ))
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
    return _run_with_ltx_stepwise_preview(pipe, args, lambda: pipe.generate_and_save(**kwargs))


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


# MLX keeps freed Metal buffers in an allocator cache so the next allocation of
# that size is free. Left uncapped, that cache competes with the LIVE tensors of
# a long video render: a 22B DiT plus a decode pass can push the machine into
# swap (or a Metal OOM abort) purely because the allocator is still holding
# buffers this render no longer needs. Capping it costs a little allocation
# throughput and buys headroom, so PortOS derives a conservative ceiling from
# physical memory and reasserts it before every render.
#
# The ceiling is a fixed fraction of physical memory clamped at both ends: the
# floor keeps a small machine from thrashing against a near-zero cache, the cap
# keeps a very large machine from parking tens of GB in the allocator "just in
# case". 1/8 of RAM lands at 2 GB on a 16 GB box, 8 GB on a 64 GB box, and hits
# the cap at 96 GB.
MLX_CACHE_FRACTION = 0.125
MLX_CACHE_FLOOR_MB = 1024
MLX_CACHE_CEILING_MB = 12288
MLX_CACHE_LIMIT_ENV = "PORTOS_MLX_CACHE_LIMIT_MB"

_MLX_CACHE_POLICY: dict = {}


def derive_mlx_cache_limit_mb(physical_bytes) -> int | None:
    """Conservative allocator-cache ceiling in MB for a machine that size.

    Pure — no MLX, no environment, no I/O. Returns None when the caller could
    not determine physical memory; resolve_mlx_cache_policy turns that into "no
    policy" rather than a guess.
    """
    if isinstance(physical_bytes, bool) or not isinstance(physical_bytes, (int, float)):
        return None
    if physical_bytes <= 0:
        return None
    derived = int(physical_bytes * MLX_CACHE_FRACTION) // (1024 * 1024)
    return max(MLX_CACHE_FLOOR_MB, min(MLX_CACHE_CEILING_MB, derived))


def validate_mlx_cache_limit_mb(raw, source: str) -> int | None:
    """Parse an explicit cache-limit override in MB; None when unset.

    An override REPLACES the derived ceiling rather than being clamped into it —
    a caller naming a number knows this machine better than a blanket fraction
    does — so validation only rejects values that cannot mean anything. A bad
    value is fatal rather than ignored: falling back to the derived ceiling
    would report a policy the caller never asked for.
    """
    if raw is None or raw == "":
        return None
    try:
        limit = int(str(raw).strip())
    except ValueError:
        limit = 0
    if limit < 1:
        raise SystemExit(f"{source} must be a positive whole number of MB; got {raw!r}.")
    return limit


def physical_memory_bytes() -> int | None:
    """Total physical RAM in bytes, or None where the platform will not say.

    Windows has no ``os.sysconf``; the helper is import-safe there and simply
    reports "unknown", which is also what the LTX runtime itself is on that OS.
    """
    sysconf = getattr(os, "sysconf", None)
    names = getattr(os, "sysconf_names", {})
    if sysconf is None or "SC_PHYS_PAGES" not in names or "SC_PAGE_SIZE" not in names:
        return None
    try:
        total = sysconf("SC_PHYS_PAGES") * sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError):  # pragma: no cover - platform dependent
        return None
    return total if total > 0 else None


def resolve_mlx_cache_policy(physical_bytes, override_raw=None, env_raw=None) -> dict:
    """Effective cache policy as ``{"limitMb": int | None, "source": str}``.

    Precedence mirrors --gemma-max-length: an explicit flag beats the ambient
    environment, which beats the ceiling derived from physical memory. A machine
    whose memory could not be read gets ``limitMb: None`` and MLX's own default
    stands — a blind floor would throttle a large box exactly as readily as it
    would protect a small one.
    """
    override = validate_mlx_cache_limit_mb(override_raw, "--mlx-cache-limit-mb")
    if override is not None:
        return {"limitMb": override, "source": "flag"}
    ambient = validate_mlx_cache_limit_mb(env_raw, MLX_CACHE_LIMIT_ENV)
    if ambient is not None:
        return {"limitMb": ambient, "source": "env"}
    derived = derive_mlx_cache_limit_mb(physical_bytes)
    if derived is None:
        return {"limitMb": None, "source": "unknown-memory"}
    return {"limitMb": derived, "source": "derived"}


def _mlx_cache_limit_setter():
    """The installed MLX's cache-limit entry point, or None when it has none.

    Probed rather than assumed, the same shape as _resolve_pipeline: the API
    moved from ``mx.metal.set_cache_limit`` to ``mx.set_cache_limit`` and the
    legacy spelling is deprecated on new wheels, while installs upgrade on their
    own schedule. New name first, legacy second.
    """
    try:
        import mlx.core as mx
    except Exception:
        return None
    setter = getattr(mx, "set_cache_limit", None)
    if callable(setter):
        return setter
    setter = getattr(getattr(mx, "metal", None), "set_cache_limit", None)
    return setter if callable(setter) else None


def apply_mlx_cache_policy(policy: dict, announce: bool = False) -> bool:
    """Push `policy` at the installed MLX. True when the limit actually took.

    Called before pipeline construction and again before every render: loading
    weights (and some pins' own setup) resets the allocator limit, so a
    once-at-startup cap quietly stops holding partway through a long job. Only
    the startup call announces — a per-render status line would be noise.
    """
    limit_mb = (policy or {}).get("limitMb")
    if limit_mb is None:
        if announce:
            emit_status("MLX allocator cache left at its default — physical memory unknown")
        return False
    setter = _mlx_cache_limit_setter()
    if setter is None:
        if announce:
            emit_status("Installed MLX exposes no cache-limit API — allocator cache left at its default")
        return False
    try:
        setter(limit_mb * 1024 * 1024)
    except Exception as err:
        if announce:
            emit_status(f"MLX allocator cache could not be capped ({err}) — left at its default")
        return False
    if announce:
        emit_status(f"MLX allocator cache capped at {limit_mb} MB ({policy.get('source')})")
    return True


def reassert_mlx_cache_policy() -> bool:
    """Re-apply this run's cache ceiling. Silent — startup already announced it.

    Called at every boundary where the allocator limit can have been reset since
    it was installed: before each render, and before the extend decode (which
    frees the DiT behind an aggressive_cleanup() and pulls the VAE back in, the
    single largest allocation of that mode). What a pipeline does INSIDE one call
    — a stage-2 transformer reload — is out of this wrapper's reach; the cap
    simply resumes at the next boundary.
    """
    return apply_mlx_cache_policy(_MLX_CACHE_POLICY)


def configure_mlx_cache(args: argparse.Namespace) -> dict:
    """Resolve this run's allocator-cache ceiling and install it. Returns the policy.

    Called once before any pipeline is constructed — the first weight load is
    already large enough to strand buffers in the cache for the rest of the run.
    _run_with_ltx_stepwise_preview reasserts the same policy per render.
    """
    global _MLX_CACHE_POLICY
    _MLX_CACHE_POLICY = resolve_mlx_cache_policy(
        physical_memory_bytes(),
        args.mlx_cache_limit_mb,
        os.environ.get(MLX_CACHE_LIMIT_ENV),
    )
    apply_mlx_cache_policy(_MLX_CACHE_POLICY, announce=True)
    return _MLX_CACHE_POLICY


def main() -> NoReturn:
    args = parse_args()
    validate_text_encoder_args(args)
    validate_reference_mode_args(args)
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
    configure_mlx_cache(args)
    # Frame-one anchor contract (#5422). Runs before any pipeline is built so a
    # pin that cannot hold the anchor through an ancestral denoise refuses in a
    # second rather than after a full model load.
    enforce_i2v_anchor_invariant(args)

    runners = {
        "text": run_text,
        "image": run_image,
        "fflf": run_fflf,
        "extend": run_extend,
        "a2v": run_a2v,
        "ic": run_ic_lora,
    }
    runner = runners[args.mode]
    # Opens the speed-profile report (no-op without --speed-profile); the
    # runner fills in which levers applied, and the reconcile below catches the
    # case where the chosen pipeline path never reached the lever at all — e.g.
    # a caller that omitted --cfg-scale, so `text` took the one-stage pipeline
    # that has no Stage-1 TeaCache to enable. Reported as degraded rather than
    # left silently absent, which would read back as "the profile applied".
    speed_profile_begin(args)
    saved_path = runner(args)
    if args.teacache and not _SPEED_PROFILE_REPORT.get("teacache") \
            and "teacache" not in _SPEED_PROFILE_REPORT.get("degraded", []):
        speed_profile_degrade(
            "teacache",
            f"TeaCache was requested but the {args.mode} render did not route through a "
            "pipeline that supports it — rendering without cache acceleration.",
        )
    speed_profile_emit()
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
