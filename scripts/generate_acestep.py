#!/usr/bin/env python3
"""
PortOS ACE-Step runner — local OSS full-song generation (prompt + lyrics).
Spawned by `server/services/pipeline/musicGen.js` as a third backend alongside
`scripts/generate_musicgen.py` and `scripts/generate_audioldm2.py`.

ACE-Step (https://github.com/ace-step/ACE-Step, Apache-2.0) is a music
*foundation* model: unlike MusicGen/AudioLDM2 (text→ambient audio), it takes a
style/tags **prompt** AND **lyrics** and renders a full, structured song with
vocals. It runs on Apple-Silicon MPS, CUDA, or CPU.

This script MIRRORS the musicgen/audioldm2 sidecar CLI/contract so the JS side
can spawn any of the three behind the same `generateMusic` path, plus a
backend-specific `--lyrics`:
  --model <hf-repo>   --text <prompt/tags>   --output <wav>   --duration <sec>
  [--lyrics <text>]  [--runtime-dir <dir>]  [--seed <int>]  [--steps <int>]
  [--guidance <float>]

`--model` is accepted for argv parity but ACE-Step resolves its own checkpoints
(auto-downloaded to ~/.cache/ace-step/checkpoints, or PORTOS_ACESTEP_CHECKPOINT_DIR
/ --runtime-dir when set); the repo id isn't a from_pretrained arg here.

Progress protocol (mirrors the other sidecars): STAGE:<name>[:detail] lines on
stderr drive the JS-side phase tracker; a final `RESULT:<json>` line on stdout
reports the saved path + actual duration.

Output: ACE-Step writes a 48 kHz stereo WAV. We ask the pipeline to render into a
temp dir (its save_path appends its own timestamped filename) and then move the
single produced file to --output, so the JS side's deterministic
`music-gen-<uuid>.wav` basename in PATHS.music is preserved.
"""

import argparse
import contextlib
import glob
import json
import os
import shutil
import sys
import tempfile
import wave


def log_stage(name, detail=""):
    """Emit a STAGE: line the JS sidecar tails for phase/progress display."""
    line = f"STAGE:{name}" + (f":{detail}" if detail else "")
    print(line, file=sys.stderr, flush=True)


def _import_pipeline(runtime_dir):
    """Resolve the ACEStepPipeline class.

    ACE-Step installs as the `acestep` pip package
    (`pip install git+https://github.com/ace-step/ACE-Step.git`). `runtime_dir`
    is honored for parity with the other sidecars — if a caller vendored a
    checkout, prepend it to sys.path first. A clear ImportError lets the JS side
    surface "run the installer" instead of a bare traceback.
    """
    if runtime_dir and os.path.isdir(runtime_dir) and runtime_dir not in sys.path:
        sys.path.insert(0, runtime_dir)
    try:
        from acestep.pipeline_ace_step import ACEStepPipeline  # type: ignore
        return ACEStepPipeline
    except ImportError as exc:
        raise ImportError(
            "Could not import ACEStepPipeline from the acestep package. Run "
            "`INSTALL_ACESTEP=1 bash scripts/setup-image-video.sh` to build the "
            f"venv (acestep + torch). (runtime-dir: {runtime_dir})"
        ) from exc


def _pick_device_id():
    """Return (device_id, is_cpu). ACE-Step takes a numeric CUDA device id; MPS
    and CPU both pass through device_id=0 and the pipeline picks the backend.
    We only need to know whether we're on CPU to widen the dtype to float32."""
    import torch

    if torch.backends.mps.is_available():
        return 0, False
    if torch.cuda.is_available():
        return 0, False
    return 0, True


def _wav_duration_seconds(path):
    """Read a WAV's duration via the stdlib so we report the TRUE rendered
    length (the model quantizes duration to its latent frame rate)."""
    with contextlib.closing(wave.open(path, "rb")) as wav:
        frames = wav.getnframes()
        rate = wav.getframerate() or 1
        return frames / float(rate)


def main():
    parser = argparse.ArgumentParser(description="PortOS ACE-Step runner")
    parser.add_argument("--model", default="ACE-Step/ACE-Step-v1-3.5B",
                        help="HF repo id (parity only; ACE-Step resolves its own checkpoints)")
    parser.add_argument("--text", required=True, help="Style/tags prompt")
    parser.add_argument("--lyrics", default="", help="Song lyrics (may include [verse]/[chorus] tags)")
    parser.add_argument("--output", required=True, help="Output WAV path")
    parser.add_argument("--duration", type=float, default=60.0, help="Target song length in seconds")
    parser.add_argument("--runtime-dir", default=os.environ.get("PORTOS_ACESTEP_RUNTIME_DIR", ""),
                        help="Optional dir prepended to sys.path before importing acestep")
    parser.add_argument("--seed", type=int, default=0, help="RNG seed (0 → pipeline default/random)")
    parser.add_argument("--steps", type=int, default=60, help="Diffusion inference steps")
    parser.add_argument("--guidance", type=float, default=15.0, help="Classifier-free guidance scale")
    args = parser.parse_args()

    text = (args.text or "").strip()
    if not text:
        print("ERROR: --text is required", file=sys.stderr, flush=True)
        return 2

    # Floor keeps the model from a zero-length latent; the JS side already clamps
    # to the engine's MAX_DURATION_SEC before spawn, so the ceiling here is just a
    # defensive sanity guard.
    duration = max(1.0, min(float(args.duration or 60.0), 600.0))
    steps = max(1, int(args.steps or 60))

    log_stage("import-runtime")
    ACEStepPipeline = _import_pipeline(args.runtime_dir)

    device_id, is_cpu = _pick_device_id()
    # bf16 on accelerators; CPU widens to float32 (bf16 matmul is slow/unsupported
    # on CPU). The pipeline itself further adjusts dtype for MPS internally.
    dtype = "float32" if is_cpu else "bfloat16"

    # Checkpoint dir: explicit env/runtime-dir wins, else let ACE-Step auto-
    # download to its default cache (~/.cache/ace-step/checkpoints).
    checkpoint_dir = os.environ.get("PORTOS_ACESTEP_CHECKPOINT_DIR", "") or None

    log_stage("load-model", args.model)
    pipe = ACEStepPipeline(
        checkpoint_dir=checkpoint_dir,
        device_id=device_id,
        dtype=dtype,
        cpu_offload=is_cpu,
    )

    # ACE-Step's __call__ appends its OWN timestamped filename when save_path is a
    # directory, so we render into a temp dir and then move the single produced
    # audio file to --output (preserving the JS side's deterministic basename).
    out_dir = os.path.dirname(os.path.abspath(args.output))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="acestep-") as tmp:
        log_stage("generate", f"{duration:.1f}s/{steps}steps")
        manual_seeds = [int(args.seed)] if args.seed else None
        pipe(
            format="wav",
            audio_duration=duration,
            prompt=text,
            lyrics=(args.lyrics or ""),
            infer_step=steps,
            guidance_scale=float(args.guidance or 15.0),
            manual_seeds=manual_seeds,
            save_path=tmp,
        )

        log_stage("encode-wav")
        produced = sorted(glob.glob(os.path.join(tmp, "*.wav")))
        if not produced:
            print("ERROR: ACE-Step produced no .wav output", file=sys.stderr, flush=True)
            return 1
        # On the off chance batch>1 ever lands here, take the first; we request
        # batch_size default (1).
        shutil.move(produced[0], args.output)

    actual_seconds = _wav_duration_seconds(args.output)
    result = {
        "output": args.output,
        "model": args.model,
        "durationSec": round(actual_seconds, 3),
    }
    print("RESULT:" + json.dumps(result), flush=True)
    log_stage("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
