#!/usr/bin/env python3
"""Technical checks for repeatable local music-renderer benchmark reports.

The analyzer is deliberately conservative: it can reject malformed or
pathological output, but it never turns numerical checks into an approval of
musical quality. A passing report still requires a human full-length listen.
"""

import argparse
import hashlib
import json
import math
import re
import sys
import wave
from array import array
from pathlib import Path


SCHEMA_VERSION = 1
TARGET_SAMPLE_RATE = 32000
SILENCE_RMS_THRESHOLD = 0.001
SPECTRAL_BAND_EDGES_HZ = (0, 80, 200, 500, 1000, 2000, 4000, 8000, 16000)


def text_shape(text):
    """Summarize text without retaining the prompt or lyrics themselves."""
    value = text if isinstance(text, str) else ""
    return {
        "characters": len(value),
        "words": len(re.findall(r"\S+", value)),
        "lines": len(value.splitlines()) if value else 0,
    }


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_pcm16(path):
    try:
        with wave.open(str(path), "rb") as wav:
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            sample_rate = wav.getframerate()
            frame_count = wav.getnframes()
            if wav.getcomptype() != "NONE":
                raise ValueError(f"unsupported WAV compression {wav.getcomptype()}")
            if channels < 1 or sample_rate < 1 or frame_count < 1:
                raise ValueError("WAV has no usable channels, sample rate, or frames")
            if sample_width != 2:
                raise ValueError(f"expected 16-bit PCM WAV, got {sample_width * 8}-bit")
            raw = wav.readframes(frame_count)
    except (OSError, EOFError, wave.Error) as error:
        raise ValueError(f"invalid WAV: {error}") from error

    expected_bytes = frame_count * channels * sample_width
    if len(raw) != expected_bytes:
        raise ValueError(f"truncated WAV payload: expected {expected_bytes} bytes, got {len(raw)}")

    samples = array("h")
    samples.frombytes(raw)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples, channels, sample_rate, frame_count


def _spectral_profile(mono_samples, sample_rate):
    """Return normalized energy in eight broad bands using fixed-size windows."""
    band_count = len(SPECTRAL_BAND_EDGES_HZ) - 1
    if not mono_samples:
        return [0.0] * band_count

    window_size = 256
    window_count = min(16, max(1, math.ceil(len(mono_samples) / window_size)))
    window = [0.5 - 0.5 * math.cos(2 * math.pi * index / (window_size - 1)) for index in range(window_size)]
    energy = [0.0] * band_count
    half_window = window_size // 2

    for window_index in range(window_count):
        max_start = max(0, len(mono_samples) - window_size)
        start = 0 if window_count == 1 else round(window_index * max_start / (window_count - 1))
        frame = [0.0] * window_size
        available = min(window_size, len(mono_samples) - start)
        for index in range(available):
            frame[index] = mono_samples[start + index] * window[index]

        for bin_index in range(1, half_window + 1):
            real = 0.0
            imaginary = 0.0
            for sample_index, value in enumerate(frame):
                angle = 2 * math.pi * bin_index * sample_index / window_size
                real += value * math.cos(angle)
                imaginary -= value * math.sin(angle)
            frequency = bin_index * sample_rate / window_size
            for band_index, (lower, upper) in enumerate(zip(SPECTRAL_BAND_EDGES_HZ, SPECTRAL_BAND_EDGES_HZ[1:])):
                if lower <= frequency < upper:
                    energy[band_index] += real * real + imaginary * imaginary
                    break

    total = sum(energy)
    return [value / total for value in energy] if total > 0 else [0.0] * band_count


def _spectral_drift(current, baseline):
    if not isinstance(baseline, list) or len(baseline) != len(current):
        return None
    return sum(abs(float(now) - float(was)) for now, was in zip(current, baseline)) / len(current)


def analyze_wav(
    path,
    expected_duration_sec,
    baseline_audio=None,
    expected_sample_rate=TARGET_SAMPLE_RATE,
    duration_tolerance_sec=1.0,
    min_rms=0.003,
    max_silent_frame_ratio=0.98,
    max_clipping_ratio=0.0005,
    max_spectral_drift=0.45,
):
    """Analyze a renderer output and return ``(audio_metrics, validation_errors)``."""
    samples, channels, sample_rate, frame_count = _read_pcm16(path)
    sample_count = len(samples)
    duration_sec = frame_count / sample_rate
    peak = max(abs(value) for value in samples) / 32768.0
    clipping_count = sum(1 for value in samples if abs(value) >= 32767)
    squared_sum = sum(value * value for value in samples)
    rms = math.sqrt(squared_sum / sample_count) / 32768.0

    mono = []
    silent_frames = 0
    for frame_index in range(frame_count):
        offset = frame_index * channels
        frame_sum = 0.0
        frame_squared_sum = 0.0
        for channel_index in range(channels):
            value = samples[offset + channel_index] / 32768.0
            frame_sum += value
            frame_squared_sum += value * value
        frame_rms = math.sqrt(frame_squared_sum / channels)
        mono.append(frame_sum / channels)
        if frame_rms <= SILENCE_RMS_THRESHOLD:
            silent_frames += 1

    spectral_profile = _spectral_profile(mono, sample_rate)
    spectral_drift = _spectral_drift(
        spectral_profile,
        baseline_audio.get("spectralProfile") if isinstance(baseline_audio, dict) else None,
    )
    metrics = {
        "durationSec": round(duration_sec, 6),
        "sampleRate": sample_rate,
        "channels": channels,
        "sampleWidthBits": 16,
        "rms": round(rms, 8),
        "peak": round(peak, 8),
        "clippingRatio": round(clipping_count / sample_count, 8),
        "silentFrameRatio": round(silent_frames / frame_count, 8),
        "spectralProfile": [round(value, 8) for value in spectral_profile],
        "spectralDrift": round(spectral_drift, 8) if spectral_drift is not None else None,
    }

    errors = []
    if sample_rate != expected_sample_rate:
        errors.append(f"unexpected sample rate: expected {expected_sample_rate}, got {sample_rate}")
    if abs(duration_sec - expected_duration_sec) > duration_tolerance_sec:
        errors.append(
            f"unexpected duration: expected {expected_duration_sec:.3f}s ± {duration_tolerance_sec:.3f}s, got {duration_sec:.3f}s",
        )
    if rms < min_rms:
        errors.append(f"near-silent output: RMS {rms:.6f} is below {min_rms:.6f}")
    if metrics["silentFrameRatio"] > max_silent_frame_ratio:
        errors.append(
            f"too much silence: {metrics['silentFrameRatio']:.3%} of frames are below the silence threshold",
        )
    if metrics["clippingRatio"] > max_clipping_ratio:
        errors.append(
            f"excessive clipping: {metrics['clippingRatio']:.3%} of samples are at full scale",
        )
    if spectral_drift is not None and spectral_drift > max_spectral_drift:
        errors.append(
            f"catastrophic spectral drift: {spectral_drift:.3f} exceeds {max_spectral_drift:.3f}",
        )
    return metrics, errors


def build_report(
    audio_path,
    prompt,
    lyrics,
    requested_duration_sec,
    backend_version,
    profile,
    elapsed_ms,
    peak_vram_mb,
    seed,
    baseline_report=None,
    **analysis_options,
):
    """Build a privacy-preserving benchmark report from one generated WAV."""
    errors = []
    try:
        checksum = sha256_file(audio_path)
    except OSError as error:
        checksum = None
        errors.append(f"could not read output checksum: {error}")

    baseline_audio = baseline_report.get("audio") if isinstance(baseline_report, dict) else None
    try:
        audio, audio_errors = analyze_wav(
            audio_path,
            requested_duration_sec,
            baseline_audio=baseline_audio,
            **analysis_options,
        )
        errors.extend(audio_errors)
    except ValueError as error:
        audio = {}
        errors.append(str(error))

    report = {
        "schemaVersion": SCHEMA_VERSION,
        "input": {
            "promptShape": text_shape(prompt),
            "lyricsShape": text_shape(lyrics),
        },
        "run": {
            "seed": int(seed),
            "requestedDurationSec": float(requested_duration_sec),
            "backendVersion": str(backend_version),
            "profile": str(profile),
            "elapsedMs": float(elapsed_ms),
            "peakVramMb": float(peak_vram_mb) if peak_vram_mb is not None else None,
        },
        "audio": {
            "sha256": checksum,
            **audio,
        },
        "validation": {
            "status": "passed" if not errors else "rejected",
            "errors": errors,
        },
        "review": {
            "listeningRequired": True,
            "status": "pending",
            "metricsAreNotSubjectiveApproval": True,
        },
    }
    return report


def _read_text(inline, path):
    if path:
        return Path(path).read_text(encoding="utf-8")
    return inline or ""


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--prompt", default="")
    parser.add_argument("--prompt-file", type=Path)
    parser.add_argument("--lyrics", default="")
    parser.add_argument("--lyrics-file", type=Path)
    parser.add_argument("--duration", type=float, required=True, help="Requested duration in seconds")
    parser.add_argument("--backend-version", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--elapsed-ms", type=float, required=True)
    parser.add_argument("--peak-vram-mb", type=float, required=True)
    parser.add_argument("--seed", type=int, required=True, help="Fixed sidecar seed used for this benchmark")
    parser.add_argument("--baseline-report", type=Path)
    parser.add_argument("--duration-tolerance-sec", type=float, default=1.0)
    args = parser.parse_args(argv)

    if args.prompt and args.prompt_file:
        parser.error("use only one of --prompt and --prompt-file")
    if args.lyrics and args.lyrics_file:
        parser.error("use only one of --lyrics and --lyrics-file")

    baseline_report = None
    if args.baseline_report:
        baseline_report = json.loads(args.baseline_report.read_text(encoding="utf-8"))
    report = build_report(
        audio_path=args.audio,
        prompt=_read_text(args.prompt, args.prompt_file),
        lyrics=_read_text(args.lyrics, args.lyrics_file),
        requested_duration_sec=args.duration,
        backend_version=args.backend_version,
        profile=args.profile,
        elapsed_ms=args.elapsed_ms,
        peak_vram_mb=args.peak_vram_mb,
        seed=args.seed,
        baseline_report=baseline_report,
        duration_tolerance_sec=args.duration_tolerance_sec,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["validation"]["status"], "errors": report["validation"]["errors"]}))
    return 0 if report["validation"]["status"] == "passed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
