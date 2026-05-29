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

Modes:
  text   → TextToVideoPipeline.generate_and_save
  image  → ImageToVideoPipeline.generate_and_save (--image)
  fflf   → KeyframeInterpolationPipeline.generate_and_save (--image start, --last-image end)
  extend → ExtendPipeline.extend_from_video (--extend-from-video, --extend-frames, --direction)
  a2v    → AudioToVideoPipeline.generate_and_save (--audio, optional --image)

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
import importlib
import json
import os
import sys
from pathlib import Path
from typing import NoReturn

# Must be set BEFORE any ltx_core_mlx import: ltx_core_mlx.model.transformer.model
# reads LTX2_DIT_EVAL_EVERY at import time. Phosphene's M4 Max 64 GB I2V Balanced
# 5s / 121 f matrix: upstream default =8 runs ~3 min/step (per-block Metal
# command-buffer churn); =1 runs ~7 s/step (~25× faster denoise); =0 is also
# fast but extends the post-decode deallocator hang. =1 wins on both axes.
# setdefault lets a caller-supplied env var override.
os.environ.setdefault("LTX2_DIT_EVAL_EVERY", "1")
os.environ.setdefault("LTX2_GEMMA_EVAL_EVERY", "1")


def emit_status(msg: str) -> None:
    """STATUS: line — single status update routed to PortOS SSE as `status`."""
    print(f"STATUS:{msg}", file=sys.stderr, flush=True)


def emit_stage(stage: int, step: int, total: int, label: str) -> None:
    """STAGE: line — structured progress, parsed as `progress` (step/total) by PortOS."""
    print(f"STAGE:{stage}:STEP:{step}:{total}:{label}", file=sys.stderr, flush=True)


def emit_download(msg: str) -> None:
    """DOWNLOAD: line — first-use HF download status routed to SSE as `status`."""
    print(f"DOWNLOAD:{msg}", file=sys.stderr, flush=True)


def configure_negative_prompt(negative_prompt: str) -> None:
    """Thread PortOS' negative prompt into ltx-2-mlx's CFG encoder.

    The dgrauet pipeline APIs don't expose `negative_prompt` on every public
    generate method. Internally, all text/video/audio pipelines read
    DEFAULT_NEGATIVE_PROMPT at call time. Post-May-9 upstream refactor the
    constant lives in up to three places:
      - ltx_pipelines_mlx.ti2vid_one_stage  (T2V / I2V / A2V one-stage paths)
      - ltx_pipelines_mlx._base             (base class used by Q8/HQ paths)
      - utils.constants                     (two-stage / extend shared import)

    We overwrite it on every module that already defines it (REPLACE semantics,
    not append). Modules absent at the current LTX2 pin are skipped silently.
    """
    if not negative_prompt:
        return

    _candidates = [
        ("ltx_pipelines_mlx", "ti2vid_one_stage"),
        ("ltx_pipelines_mlx", "_base"),
        ("utils", "constants"),
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


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="PortOS ltx-2-mlx bridge")
    p.add_argument("--mode", required=True, choices=["text", "image", "fflf", "extend", "a2v"])
    p.add_argument("--prompt", required=True)
    p.add_argument("--negative-prompt", default="")
    p.add_argument("--output", required=True, help="Output .mp4 path")
    p.add_argument("--model", required=True, help="HF repo id or local path (e.g. dgrauet/ltx-2.3-mlx-q4)")
    p.add_argument("--gemma", default="mlx-community/gemma-3-12b-it-4bit")
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
                        "dev transformer for stage 2. Default for fflf: "
                        "ltx-2.3-22b-distilled-lora-384.safetensors.")
    p.add_argument("--lora-strength", type=float, default=1.0,
                   help="Distilled-LoRA fusion strength (default 1.0, matches dgrauet's CLI).")
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
    return p.parse_args()


def bind_output_fps(pipe, fps: float) -> None:
    """Make pipeline generate_and_save() calls decode at the requested FPS."""
    decode_and_save = pipe._decode_and_save_video

    def decode_with_fps(video_latent, audio_latent, output_path, fps=fps):
        return decode_and_save(video_latent, audio_latent, output_path, fps=fps)

    pipe._decode_and_save_video = decode_with_fps


def configure_image_strength(image_strength: float | None) -> None:
    """Thread PortOS' I2V strength into ltx-2-mlx conditioning constructors."""
    if image_strength is None:
        return
    if image_strength < 0.0 or image_strength > 1.0:
        raise SystemExit("--image-strength must be between 0.0 and 1.0")

    from ltx_core_mlx.conditioning.types.latent_cond import VideoConditionByLatentIndex as BaseCondition
    from ltx_pipelines_mlx import ti2vid_one_stage

    class PortOSVideoCondition(BaseCondition):
        def __init__(self, frame_indices, clean_latent, strength=1.0):
            super().__init__(frame_indices, clean_latent, strength=image_strength)

    ti2vid_one_stage.VideoConditionByLatentIndex = PortOSVideoCondition
    try:
        from ltx_pipelines_mlx import ti2vid_two_stages
        ti2vid_two_stages.VideoConditionByLatentIndex = PortOSVideoCondition
    except ImportError:
        pass
    emit_status(f"Using image strength {image_strength:g}")


def run_two_stage(args: argparse.Namespace, image: str | None = None) -> str:
    """T2V/I2V path that honors CFG via the dgrauet two-stage pipeline."""
    from ltx_pipelines_mlx import TwoStagePipeline
    emit_status(f"Loading two-stage pipeline ({args.model})…")
    emit_stage(1, 0, 1, "Loading model")
    pipe = TwoStagePipeline(
        model_dir=args.model,
        gemma_model_id=args.gemma,
        dev_transformer=args.dev_transformer or "transformer-dev.safetensors",
        distilled_lora=args.distilled_lora or "ltx-2.3-22b-distilled-lora-384.safetensors",
        distilled_lora_strength=args.lora_strength,
    )
    bind_output_fps(pipe, args.fps)
    emit_stage(1, 1, 1, "Loaded")
    emit_status("Generating with CFG…")
    return pipe.generate_and_save(
        prompt=args.prompt,
        output_path=args.output,
        image=image,
        height=args.height,
        width=args.width,
        num_frames=args.num_frames,
        seed=args.seed,
        stage1_steps=args.steps if args.steps is not None else 30,
        stage2_steps=args.stage2_steps,
        cfg_scale=args.cfg_scale if args.cfg_scale is not None else 3.0,
    )


def run_text(args: argparse.Namespace) -> str:
    if args.cfg_scale is not None:
        return run_two_stage(args)
    from ltx_pipelines_mlx import TextToVideoPipeline
    emit_status(f"Loading T2V pipeline ({args.model})…")
    emit_stage(1, 0, 1, "Loading model")
    pipe = TextToVideoPipeline(model_dir=args.model, gemma_model_id=args.gemma)
    bind_output_fps(pipe, args.fps)
    emit_stage(1, 1, 1, "Loaded")
    emit_status("Generating T2V…")
    return pipe.generate_and_save(
        prompt=args.prompt,
        output_path=args.output,
        height=args.height,
        width=args.width,
        num_frames=args.num_frames,
        seed=args.seed,
        num_steps=args.steps,
    )


def run_image(args: argparse.Namespace) -> str:
    configure_image_strength(args.image_strength)
    if args.cfg_scale is not None:
        if not args.image:
            raise SystemExit("--image is required for image mode")
        return run_two_stage(args, image=args.image)
    from ltx_pipelines_mlx import ImageToVideoPipeline
    if not args.image:
        raise SystemExit("--image is required for image mode")
    emit_status(f"Loading I2V pipeline ({args.model})…")
    emit_stage(1, 0, 1, "Loading model")
    pipe = ImageToVideoPipeline(model_dir=args.model, gemma_model_id=args.gemma)
    bind_output_fps(pipe, args.fps)
    emit_stage(1, 1, 1, "Loaded")
    emit_status("Generating I2V…")
    return pipe.generate_and_save(
        prompt=args.prompt,
        output_path=args.output,
        image=args.image,
        height=args.height,
        width=args.width,
        num_frames=args.num_frames,
        seed=args.seed,
        num_steps=args.steps,
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
    from ltx_pipelines_mlx import KeyframeInterpolationPipeline
    keyframe_images, keyframe_indices = _resolve_keyframes(args)
    # Keyframe interpolation needs the dev (non-distilled) transformer +
    # the distilled LoRA fused on top for stage 2. Defaults match the file
    # names in dgrauet/ltx-2.3-mlx-q4 and dgrauet/ltx-2.3-mlx-q8 — caller
    # can override via --dev-transformer / --distilled-lora when a future
    # repo renames them.
    dev_transformer = args.dev_transformer or "transformer-dev.safetensors"
    distilled_lora = args.distilled_lora or "ltx-2.3-22b-distilled-lora-384.safetensors"
    emit_status(f"Loading Keyframe pipeline ({args.model}, dev+lora)…")
    emit_stage(1, 0, 1, "Loading model")
    pipe = KeyframeInterpolationPipeline(
        model_dir=args.model,
        gemma_model_id=args.gemma,
        dev_transformer=dev_transformer,
        distilled_lora=distilled_lora,
        distilled_lora_strength=args.lora_strength,
    )
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
        fps=args.fps,
        seed=args.seed,
        stage1_steps=args.steps,
        stage2_steps=args.stage2_steps,
        cfg_scale=args.cfg_scale if args.cfg_scale is not None else 3.0,
    )


def run_extend(args: argparse.Namespace) -> str:
    """Extend an existing video by N latent frames (1 latent ≈ 8 pixel frames).
    Conditions on the entire source video's latent — motion AND visual content
    flow into the new frames. Mirrors dgrauet's CLI `_cmd_extend` memory pattern:
    free DiT + text encoder before decode (otherwise OOMs at the VAE pass).
    """
    from ltx_pipelines_mlx import ExtendPipeline
    from ltx_core_mlx.utils.memory import aggressive_cleanup
    if not args.extend_from_video:
        raise SystemExit("--extend-from-video is required for extend mode")
    emit_status(f"Loading Extend pipeline ({args.model})…")
    emit_stage(1, 0, 1, "Loading model")
    pipe = ExtendPipeline(model_dir=args.model, gemma_model_id=args.gemma)
    emit_stage(1, 1, 1, "Loaded")
    emit_status(f"Extending video {args.extend_direction} by {args.extend_frames} latent frames…")
    video_latent, audio_latent = pipe.extend_from_video(
        prompt=args.prompt,
        video_path=args.extend_from_video,
        extend_frames=args.extend_frames,
        direction=args.extend_direction,
        seed=args.seed,
        num_steps=args.steps if args.steps is not None else 30,
        cfg_scale=args.cfg_scale if args.cfg_scale is not None else 3.0,
    )
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
    from ltx_pipelines_mlx import AudioToVideoPipeline
    if not args.audio:
        raise SystemExit("--audio is required for a2v mode")
    emit_status(f"Loading A2V pipeline ({args.model})…")
    emit_stage(1, 0, 1, "Loading model")
    pipe = AudioToVideoPipeline(model_dir=args.model, gemma_model_id=args.gemma)
    emit_stage(1, 1, 1, "Loaded")
    emit_status(f"Generating A2V from {Path(args.audio).name}…")
    return pipe.generate_and_save(
        prompt=args.prompt,
        output_path=args.output,
        audio_path=args.audio,
        image=args.image,
        height=args.height,
        width=args.width,
        num_frames=args.num_frames,
        fps=args.fps,
        seed=args.seed,
        stage1_steps=args.steps,
        stage2_steps=args.stage2_steps,
        cfg_scale=args.cfg_scale if args.cfg_scale is not None else 3.0,
        audio_start_time=args.audio_start,
    )


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
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    configure_negative_prompt(args.negative_prompt)

    runners = {
        "text": run_text,
        "image": run_image,
        "fflf": run_fflf,
        "extend": run_extend,
        "a2v": run_a2v,
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
