"""Prepare AvatarForcing inference and optionally render an offline diagnostics clip."""

import argparse
import math
import os
import subprocess
import tempfile
import time
from pathlib import Path

import numpy as np
import torch
from safetensors.torch import load_file
from scipy.io import wavfile
from scipy.signal import resample_poly
from transformers import Wav2Vec2Model

from appearance import decode, encode, project_motion
from motion import FRAMES_PER_SECOND, SAMPLE_RATE, WINDOW, audio_latents, idle_blocks, sample
from still import tensor_image


def read_wave(path, duration):
    rate, data = wavfile.read(path)
    if not 8_000 <= rate <= 192_000 or not data.size or data.shape[0] < rate // 10:
        raise ValueError("Expected at least 100 ms of WAV audio at a supported sample rate")
    data = data[:int(rate * duration)]
    dtype = data.dtype
    if dtype == np.uint8:
        data = (data.astype(np.float32) - 128) / 128
    elif np.issubdtype(dtype, np.signedinteger):
        data = data.astype(np.float32) / -np.iinfo(dtype).min
    else:
        data = data.astype(np.float32)
    if data.ndim == 2:
        data = data.mean(axis=1)
    if not np.isfinite(data).all():
        raise ValueError("Audio contains invalid samples")
    divisor = math.gcd(rate, SAMPLE_RATE)
    return resample_poly(data, SAMPLE_RATE // divisor, rate // divisor).astype(np.float32)


def runtime_weights(root, name, device, dtype):
    path = root / "tensor" / (name + ".safetensors")
    return {key: value.to(device=device, dtype=dtype if value.is_floating_point() else value.dtype)
            for key, value in load_file(path, device="cpu").items()}


@torch.inference_mode()
def prepare(args, log=print):
    if args.device == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("MPS is not available")
    dtype = torch.float16 if args.half else torch.float32
    if args.half and args.device == "cpu":
        raise ValueError("Half precision is only available on MPS")
    start = time.perf_counter()
    appearance = runtime_weights(args.weights, "motion_autoencoder", args.device, dtype)
    motion = runtime_weights(args.weights, "flow_transformer", args.device, dtype)
    model = Wav2Vec2Model.from_pretrained(args.weights / "audio", local_files_only=True,
                                         trust_remote_code=False, use_safetensors=True).eval().to(args.device)
    log(f"Offline models loaded in {time.perf_counter() - start:.2f}s.", flush=True)
    reference = tensor_image(args.portrait, args.device).to(dtype)
    identity, pyramid = encode(reference, appearance)
    initial_motion = project_motion(identity, appearance)
    torch.mps.synchronize() if args.device == "mps" else None
    log(f"Models and portrait ready in {time.perf_counter() - start:.2f}s.", flush=True)
    return appearance, motion, model, identity, pyramid, initial_motion


def decode_blocks(blocks, appearance, identity, pyramid, frame_batch, cancelled):
    for predicted in blocks:
        for group in predicted[0].split(frame_batch):
            if cancelled():
                return
            pixels = decode(identity + group, pyramid, appearance)
            if not pixels.isfinite().all().item():
                raise RuntimeError("Model produced a nonfinite frame")
            rgb = ((pixels.clamp(-1, 1).permute(0, 2, 3, 1).float().cpu() + 1) * 127.5)
            yield rgb.byte().numpy()


@torch.inference_mode()
def with_portrait(prepared, source, args):
    """Re-encode the identity the model animates from another portrait, reusing the loaded weights."""
    appearance, motion, model, _, _, _ = prepared
    dtype = torch.float16 if args.half else torch.float32
    identity, pyramid = encode(tensor_image(source, args.device).to(dtype), appearance)
    initial_motion = project_motion(identity, appearance)
    if not identity.isfinite().all().item():
        raise ValueError("Portrait produced a nonfinite identity")
    return appearance, motion, model, identity, pyramid, initial_motion


@torch.inference_mode()
def prepare_silence(prepared, args):
    _, motion, model, _, _, _ = prepared
    zeros = torch.zeros((1, SAMPLE_RATE * WINDOW // FRAMES_PER_SECOND), dtype=torch.float32, device=args.device)
    return audio_latents(model, zeros, motion)[:, :WINDOW]


@torch.inference_mode()
def frames(prepared, audio, args, cancelled=lambda: False, state=None, on_state=None):
    appearance, motion, model, identity, pyramid, initial_motion = prepared
    normalized = (audio - audio.mean()) / np.sqrt(audio.var() + 1e-7)
    conditioning = audio_latents(model, torch.from_numpy(normalized)[None].to(args.device), motion)
    blocks = sample(motion, conditioning, initial_motion, steps=args.steps, seed=args.seed,
                    cancelled=cancelled, state=state, on_state=on_state)
    yield from decode_blocks(blocks, appearance, identity, pyramid, args.frame_batch, cancelled)


@torch.inference_mode()
def idle_frames(prepared, silence_window, args, *, stage="idle", seed=66, cancelled=lambda: False,
                state=None, on_state=None, max_blocks=150):
    appearance, motion, _, identity, pyramid, initial_motion = prepared
    blocks = idle_blocks(motion, silence_window, initial_motion, steps=args.steps, seed=seed,
                         stage=stage, cancelled=cancelled, state=state, on_state=on_state,
                         max_blocks=max_blocks)
    yield from decode_blocks(blocks, appearance, identity, pyramid, args.frame_batch, cancelled)


def render(args, prepared, output):
    loaded = time.perf_counter()
    audio = read_wave(args.wav, args.seconds)
    frame_count = 0

    with tempfile.TemporaryDirectory(prefix=".render-", dir=output.parent) as dirname:
        staging = Path(dirname) / "output.mp4"
        narration = Path(dirname) / "audio.wav"
        wavfile.write(narration, SAMPLE_RATE, (audio.clip(-1, 1) * 32767).astype(np.int16))
        ffmpeg = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                  "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "512x512",
                  "-framerate", str(FRAMES_PER_SECOND), "-i", "pipe:0", "-i", str(narration),
                  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast",
                  "-c:a", "aac", "-shortest", str(staging)]
        with subprocess.Popen(ffmpeg, stdin=subprocess.PIPE) as encoder:
            try:
                for group in frames(prepared, audio, args):
                    encoder.stdin.write(group.tobytes())
                    if frame_count == 0:
                        print(f"First reconstructed speech frame: {time.perf_counter() - loaded:.2f}s from WAV input.", flush=True)
                    frame_count += len(group)
                encoder.stdin.close()
            except BaseException:
                encoder.kill()
                raise
            if encoder.wait() != 0 or not frame_count:
                raise RuntimeError("Offline clip encoding failed")
        os.link(staging, output)
    print(f"{frame_count} generated frames in {time.perf_counter() - loaded:.2f}s from WAV input.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("weights", "portrait", "wav", "output"):
        parser.add_argument(name, type=Path)
    parser.add_argument("--device", choices=["mps", "cpu"], default="mps")
    parser.add_argument("--half", action="store_true")
    parser.add_argument("--seconds", type=float, default=5)
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--repeat", type=int, choices=(1, 2), default=1)
    parser.add_argument("--seed", type=int, default=66)
    parser.add_argument("--frame-batch", type=int, default=4)
    args = parser.parse_args()
    if not 0.2 <= args.seconds <= 12 or not 1 <= args.steps <= 20 or not 1 <= args.frame_batch <= 10:
        parser.error("Request is outside bounded pilot duration, steps, or frame batch")
    prepared = prepare(args)
    for index in range(args.repeat):
        output = args.output if not index else args.output.with_stem(args.output.stem + "-warm")
        print(f"Render {index + 1}", flush=True)
        render(args, prepared, output)


if __name__ == "__main__":
    main()
