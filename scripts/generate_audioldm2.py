#!/usr/bin/env python3
"""
PortOS AudioLDM2 runner — local OSS long-form background-music generation.
Spawned by `server/services/pipeline/musicGen.js` as a sibling backend to
`scripts/generate_musicgen.py`.

Pipeline Audio Phase 4c.2 shipped local MusicGen (MLX) as the first generator
behind the audio stage's `source: 'gen'` library entry. AudioLDM2 is the second
backend: a latent-diffusion text-to-audio model (CVSSP/audioldm2) that runs via
HuggingFace `diffusers`. Its draw over MusicGen is *long-form* output — MusicGen
degrades past ~30s (trained on 30s windows), whereas AudioLDM2 takes an explicit
`audio_length_in_s` and renders coherent clips well past that, with no API key
and no network at inference time (after the one-time weight download).

This script deliberately MIRRORS generate_musicgen.py's CLI/contract so the JS
side can spawn either behind the same `generateMusic` path:
  --model <hf-repo>   --text <prompt>   --output <wav>   --duration <seconds>
  [--runtime-dir <dir>]  [--seed <int>]  [--steps <int>]  [--guidance <float>]

Progress protocol (mirrors the image/video/musicgen sidecars): STAGE:<name>
[:detail] lines on stderr drive the JS-side phase tracker; a final
`RESULT:<json>` line on stdout reports the saved path + actual duration.

Output: a 16 kHz mono 16-bit PCM WAV at --output. AudioLDM2 generates at 16 kHz;
we write the WAV with the stdlib `wave` module (+ numpy for the float→int16
conversion) rather than depending on scipy/soundfile, matching the musicgen
sidecar so the runtime's dependency surface stays small.
"""

import argparse
import json
import os
import sys
import wave


# AudioLDM2 decodes audio at 16 kHz (fixed by the model's VAE / vocoder).
SAMPLE_RATE = 16000


def log_stage(name, detail=""):
    """Emit a STAGE: line the JS sidecar tails for phase/progress display."""
    line = f"STAGE:{name}" + (f":{detail}" if detail else "")
    print(line, file=sys.stderr, flush=True)


def _import_pipeline(runtime_dir):
    """Resolve the diffusers AudioLDM2Pipeline class.

    AudioLDM2 ships in HuggingFace `diffusers` (a pip package), so unlike the
    MLX MusicGen example we normally just import it. `runtime_dir` is honored
    for parity with the musicgen sidecar — if a caller vendored a diffusers
    build into a clone dir, prepend it to sys.path first. Raising a clear
    ImportError lets the JS side surface "run the installer" rather than a bare
    traceback.
    """
    if runtime_dir and os.path.isdir(runtime_dir) and runtime_dir not in sys.path:
        sys.path.insert(0, runtime_dir)
    try:
        from diffusers import AudioLDM2Pipeline  # type: ignore
        return AudioLDM2Pipeline
    except ImportError as exc:
        raise ImportError(
            "Could not import AudioLDM2Pipeline from diffusers. Run "
            "`INSTALL_AUDIOLDM2=1 bash scripts/setup-image-video.sh` to build "
            f"the venv (torch + diffusers + transformers; looked in: {runtime_dir})."
        ) from exc


def _pick_device():
    """Prefer Apple-Silicon MPS, then CUDA, else CPU.

    Returns the torch device string. AudioLDM2 runs on all three; MPS is the
    common case on PortOS's target hardware (Apple Silicon), CUDA covers Linux
    GPU boxes, CPU is the slow fallback so generation still completes.
    """
    import torch

    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _patch_language_model_generation(pipe):
    """Re-bind GenerationMixin generation helpers onto AudioLDM2's language model.

    AudioLDM2's `language_model` is a bare `GPT2Model` (no LM head — the pipeline
    reads its hidden states). diffusers' `AudioLDM2Pipeline.generate_language_model`
    drives it by hand and calls `_update_model_kwargs_for_generation` (and, on
    transformers >=4.52.1, `_get_initial_cache_position`). Those used to live on
    every `PreTrainedModel`, but transformers >=4.50 decoupled `GenerationMixin`
    so non-generative base models like `GPT2Model` no longer carry them — leaving
    diffusers calling a method that no longer exists:
        AttributeError: 'GPT2Model' object has no attribute
        '_update_model_kwargs_for_generation'

    We restore the missing helpers from `GenerationMixin` onto the model's class
    (their signatures already match diffusers' call sites). This keeps the venv on
    a current transformers instead of pinning an EOL release. No-op on older
    transformers where the methods are already present.
    """
    lm = getattr(pipe, "language_model", None)
    if lm is None:
        return
    try:
        from transformers.generation.utils import GenerationMixin
    except Exception:
        return
    cls = type(lm)
    for name in ("_update_model_kwargs_for_generation", "_get_initial_cache_position"):
        if not hasattr(lm, name) and hasattr(GenerationMixin, name):
            setattr(cls, name, getattr(GenerationMixin, name))


def _to_int16_pcm(audio):
    """Flatten a numpy audio array to a 1-D int16 numpy buffer.

    AudioLDM2 returns a float array (shape [batch, samples]); we take the first
    waveform, flatten to mono, clip to [-1, 1] so a hot sample can't wrap on the
    int16 cast, and scale to full-scale PCM. Mirrors the musicgen sidecar's
    conversion so both backends emit byte-identical WAV framing.
    """
    import numpy as np

    arr = np.array(audio, dtype=np.float32)
    if arr.ndim > 1:
        arr = arr[0]
    arr = arr.reshape(-1)
    np.clip(arr, -1.0, 1.0, out=arr)
    return (arr * 32767.0).astype(np.int16)


def _write_wav(path, pcm_int16):
    with wave.open(path, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)  # 16-bit
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm_int16.tobytes())


def main():
    parser = argparse.ArgumentParser(description="PortOS AudioLDM2 runner (diffusers)")
    parser.add_argument("--model", default="cvssp/audioldm2",
                        help="HF repo id of the AudioLDM2 weights")
    parser.add_argument("--text", required=True, help="Text prompt")
    parser.add_argument("--output", required=True, help="Output WAV path")
    parser.add_argument("--duration", type=float, default=20.0,
                        help="Target clip length in seconds (long-form supported)")
    parser.add_argument("--runtime-dir", default=os.environ.get("PORTOS_AUDIOLDM2_RUNTIME_DIR", ""),
                        help="Optional dir prepended to sys.path before importing diffusers")
    parser.add_argument("--seed", type=int, default=0,
                        help="RNG seed for reproducible generation")
    parser.add_argument("--steps", type=int, default=200,
                        help="Number of diffusion inference steps")
    parser.add_argument("--guidance", type=float, default=3.5,
                        help="Classifier-free guidance scale")
    args = parser.parse_args()

    text = (args.text or "").strip()
    if not text:
        print("ERROR: --text is required", file=sys.stderr, flush=True)
        return 2

    # AudioLDM2 supports long-form, but a hard floor keeps the VAE from
    # producing a zero-length latent; the ceiling is a sanity guard, not a model
    # limit (the JS side clamps to MAX_DURATION_SEC for its engine before here).
    duration = max(1.0, min(float(args.duration or 20.0), 300.0))
    steps = max(1, int(args.steps or 200))

    log_stage("import-runtime")
    AudioLDM2Pipeline = _import_pipeline(args.runtime_dir)

    import torch

    device = _pick_device()
    # float16 on accelerators halves memory + speeds inference; CPU stays float32
    # because half-precision matmul is unsupported / slow there.
    dtype = torch.float32 if device == "cpu" else torch.float16

    log_stage("load-model", args.model)
    pipe = AudioLDM2Pipeline.from_pretrained(args.model, torch_dtype=dtype)
    pipe = pipe.to(device)
    # transformers >=4.50 compatibility: restore the generation helpers the
    # pipeline's language-model loop relies on (see helper docstring).
    _patch_language_model_generation(pipe)

    # PyTorch's MPS backend does not support torch.Generator(device='mps') — it
    # raises before inference on Apple Silicon (our primary target). Seed on CPU
    # there; diffusers accepts a CPU generator for an MPS pipeline. CUDA/CPU use
    # their native device generator. https://github.com/pytorch/pytorch/issues/84288
    generator_device = "cpu" if device == "mps" else device
    generator = torch.Generator(device=generator_device).manual_seed(int(args.seed or 0))

    log_stage("generate", f"{duration:.1f}s/{steps}steps")
    out = pipe(
        text,
        num_inference_steps=steps,
        audio_length_in_s=duration,
        guidance_scale=float(args.guidance or 3.5),
        generator=generator,
    )

    log_stage("encode-wav")
    pcm = _to_int16_pcm(out.audios)
    out_dir = os.path.dirname(os.path.abspath(args.output))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    _write_wav(args.output, pcm)

    # The rendered length can differ slightly from the request (the model
    # quantizes to its latent frame rate). Report what we actually wrote so the
    # JS side persists truth — identical contract to the musicgen sidecar.
    actual_seconds = len(pcm) / float(SAMPLE_RATE)
    result = {
        "output": args.output,
        "model": args.model,
        "durationSec": round(actual_seconds, 3),
        "sampleRate": SAMPLE_RATE,
    }
    print("RESULT:" + json.dumps(result), flush=True)
    log_stage("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
