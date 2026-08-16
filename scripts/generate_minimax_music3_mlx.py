#!/usr/bin/env python3
"""MiniMax Music 3 MLX sidecar using PortOS' STAGE/RESULT protocol."""

import argparse
import json
import os
import sys
import wave


TARGET_SAMPLE_RATE = 32000


def to_stereo(audio, np):
    """Orient an MLX/NumPy waveform to (2, samples) float32."""
    audio = np.squeeze(np.asarray(audio)).astype(np.float32)
    if audio.size == 0:
        raise RuntimeError("MiniMax Music 3 MLX returned empty audio")
    if audio.ndim == 1:
        return np.stack([audio, audio])
    if audio.ndim != 2:
        raise RuntimeError(f"unexpected audio shape {audio.shape}")
    if audio.shape[0] == 2:
        return audio
    if audio.shape[0] == 1:
        return np.repeat(audio, 2, axis=0)
    if audio.shape[1] == 2:
        return audio.T
    if audio.shape[1] == 1:
        return np.repeat(audio.T, 2, axis=0)
    raise RuntimeError(f"could not orient audio shape {audio.shape} to stereo")


def resample_to_target(audio, source_rate, np, target_rate=TARGET_SAMPLE_RATE):
    """Resample (2, samples) audio to the library's existing 32 kHz rate."""
    if source_rate == target_rate:
        return audio
    if source_rate <= 0:
        raise RuntimeError(f"invalid MiniMax Music 3 MLX sample rate {source_rate}")
    target_length = max(1, round(audio.shape[1] * target_rate / source_rate))
    source_x = np.arange(audio.shape[1], dtype=np.float64)
    target_x = np.linspace(0, audio.shape[1] - 1, target_length)
    return np.stack([np.interp(target_x, source_x, channel) for channel in audio])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--revision", default="")
    parser.add_argument("--text", required=True)
    parser.add_argument("--lyrics", default="")
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--runtime-dir", default="")
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    if args.runtime_dir:
        sys.path.insert(0, args.runtime_dir)

    import numpy as np
    from mlx_audio.music import load

    print("STAGE:load-model", file=sys.stderr, flush=True)
    model = load(args.model, revision=args.revision) if args.revision else load(args.model)
    print("STAGE:generate", file=sys.stderr, flush=True)
    requested_duration = float(max(1, min(300, args.duration)))
    chunks = []
    sample_rate = None
    for result in model.generate(
        text=args.text,
        lyrics=args.lyrics,
        duration=requested_duration,
        steps=args.steps,
        seed=args.seed,
    ):
        result_rate = int(result.sample_rate)
        if sample_rate is None:
            sample_rate = result_rate
        elif result_rate != sample_rate:
            raise RuntimeError("MiniMax Music 3 MLX returned inconsistent sample rates")
        chunks.append(to_stereo(result.audio, np))

    if not chunks or sample_rate is None:
        raise RuntimeError("MiniMax Music 3 MLX produced no audio")

    audio = np.concatenate(chunks, axis=1)
    audio = resample_to_target(audio, sample_rate, np)
    pcm = (np.clip(audio, -1, 1).T * 32767).astype(np.int16)
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with wave.open(args.output, "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(TARGET_SAMPLE_RATE)
        wav.writeframes(pcm.tobytes())
    print("RESULT:" + json.dumps({"durationSec": len(pcm) / TARGET_SAMPLE_RATE, "sampleRate": TARGET_SAMPLE_RATE}), flush=True)


if __name__ == "__main__":
    main()
