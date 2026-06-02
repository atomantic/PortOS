#!/usr/bin/env python3
"""
PortOS MusicGen runner — local OSS background-music generation on Apple
Silicon via MLX. Spawned by `server/services/pipeline/musicGen.js`.

Pipeline Audio Phase 4c.2: the first local music generator behind the audio
stage's `source: 'gen'` library entry. Meta's MusicGen (MLX port) generates
bounded text-conditioned clips (~up to 30s) entirely on-device — no network,
no API key — matching PortOS's "local OSS first" media strategy.

Runtime: the MLX MusicGen implementation lives in ml-explore/mlx-examples
(`musicgen/`), which isn't a pip package. `INSTALL_MUSICGEN=1 bash
scripts/setup-image-video.sh` clones it to ~/.portos/mlx-examples and builds a
sibling venv at ~/.portos/venv-musicgen. The JS caller passes the clone's
`musicgen/` dir via --runtime-dir so this script can import `MusicGen` from it;
we also fall back to a plain `import musicgen` for installs that vendored it
onto the path some other way.

Progress protocol (mirrors the image/video sidecars): STAGE:<name>[:detail]
lines on stderr drive the JS-side phase tracker; a final `RESULT:<json>` line
on stdout reports the saved path + duration.

Output: a 32 kHz mono 16-bit PCM WAV at --output. We write the WAV with the
stdlib `wave` module (+ numpy for the float→int16 conversion) rather than
depending on scipy/soundfile, so the runtime's dependency surface stays small.
"""

import argparse
import json
import os
import sys
import wave


# MusicGen decodes audio at 32 kHz; the EnCodec frame rate is 50 Hz, so one
# second of audio is 50 decoder steps. Both are fixed by the model.
SAMPLE_RATE = 32000
STEPS_PER_SECOND = 50


def log_stage(name, detail=""):
    """Emit a STAGE: line the JS sidecar tails for phase/progress display."""
    line = f"STAGE:{name}" + (f":{detail}" if detail else "")
    print(line, file=sys.stderr, flush=True)


def _import_musicgen(runtime_dir):
    """Resolve the MLX MusicGen class.

    Prefer the clone dir the JS caller points us at (the mlx-examples
    `musicgen/` package directory); fall back to an importable `musicgen`
    module for installs that placed it on PYTHONPATH another way. Raising a
    clear ImportError here lets the JS side surface "run the installer" rather
    than a bare traceback.
    """
    if runtime_dir and os.path.isdir(runtime_dir) and runtime_dir not in sys.path:
        sys.path.insert(0, runtime_dir)
    try:
        from musicgen import MusicGen  # type: ignore
        return MusicGen
    except ImportError as exc:
        raise ImportError(
            "Could not import MusicGen from the MLX runtime. Run "
            "`INSTALL_MUSICGEN=1 bash scripts/setup-image-video.sh` to clone "
            f"ml-explore/mlx-examples and build the venv (looked in: {runtime_dir})."
        ) from exc


def _to_int16_pcm(audio):
    """Flatten an mlx/numpy audio array to a 1-D int16 numpy buffer.

    MusicGen returns a float array (typically shape [samples, 1] or
    [1, samples]); we flatten to mono, clip to [-1, 1] so a hot sample can't
    wrap on the int16 cast, and scale to full-scale PCM.
    """
    import numpy as np

    arr = np.array(audio, dtype=np.float32).reshape(-1)
    np.clip(arr, -1.0, 1.0, out=arr)
    return (arr * 32767.0).astype(np.int16)


def _write_wav(path, pcm_int16):
    with wave.open(path, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)  # 16-bit
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm_int16.tobytes())


def main():
    parser = argparse.ArgumentParser(description="PortOS MusicGen runner (MLX)")
    parser.add_argument("--model", default="facebook/musicgen-medium",
                        help="HF repo id of the MusicGen weights")
    parser.add_argument("--text", required=True, help="Text prompt")
    parser.add_argument("--output", required=True, help="Output WAV path")
    parser.add_argument("--duration", type=float, default=12.0,
                        help="Target clip length in seconds")
    parser.add_argument("--runtime-dir", default=os.environ.get("PORTOS_MUSICGEN_RUNTIME_DIR", ""),
                        help="Path to the mlx-examples musicgen/ package dir")
    args = parser.parse_args()

    text = (args.text or "").strip()
    if not text:
        print("ERROR: --text is required", file=sys.stderr, flush=True)
        return 2

    # Clamp duration into the model's practical window. MusicGen degrades past
    # ~30s (it was trained on 30s windows); a 0.5s floor keeps max_steps >= 1.
    duration = max(0.5, min(float(args.duration or 12.0), 30.0))
    max_steps = max(1, round(duration * STEPS_PER_SECOND))

    log_stage("import-runtime")
    MusicGen = _import_musicgen(args.runtime_dir)

    log_stage("load-model", args.model)
    model = MusicGen.from_pretrained(args.model)

    log_stage("generate", f"{duration:.1f}s/{max_steps}steps")
    audio = model.generate(text, max_steps=max_steps)

    log_stage("encode-wav")
    pcm = _to_int16_pcm(audio)
    out_dir = os.path.dirname(os.path.abspath(args.output))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    _write_wav(args.output, pcm)

    # The actual rendered length can differ slightly from the request (integer
    # step count). Report what we actually wrote so the JS side persists truth.
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
