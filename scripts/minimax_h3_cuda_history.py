"""PortOS-owned bounded history adapter for Diffusers H3's FL2VA checkpoint.

Only the CLI interval contract is shared with MLX. No reference runner is
imported. Native modular blocks own encoding, noise, sampling and decoding;
this adapter inserts clean history rows and advances the target rotary clock.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import signal
import tempfile
from pathlib import Path

CONTRACT = json.loads(Path(__file__).with_suffix(".json").read_text(encoding="utf-8"))


def assert_runtime_contract(args):
    """Check installed bytes and package/model pins before importing or loading models."""
    if (args.model_repo, args.model_revision) != (CONTRACT["model"]["repo"], CONTRACT["model"]["revision"]):
        raise RuntimeError("H3 CUDA history requires the pinned FL2VA checkpoint.")
    for package, version in CONTRACT["runtimePackages"].items():
        try:
            installed = importlib.metadata.distribution(package)
        except importlib.metadata.PackageNotFoundError as exc:
            raise RuntimeError(f"H3 CUDA history requires {package}=={version}. Repair the CUDA runtime.") from exc
        if installed.version != version:
            raise RuntimeError(f"H3 CUDA history requires {package}=={version}. Repair the CUDA runtime.")
        if package == "diffusers":
            for filename, digest in CONTRACT["sourceSha256"].items():
                source = Path(installed.locate_file(filename))
                if not source.is_file() or hashlib.sha256(source.read_bytes().replace(b"\r\n", b"\n")).hexdigest() != digest:
                    raise RuntimeError(f"H3 CUDA history hook changed: {filename}. Repair the pinned runtime.")
    from diffusers import MiniMaxH3Scheduler

    for shift in (12.0, 3.0):
        scheduler = MiniMaxH3Scheduler(shift=shift)
        scheduler.set_timesteps(8)
        if len(scheduler.timesteps) != 7 or float(scheduler.timesteps[0]) != 0.0 or float(scheduler.sigmas[-1]) != 0.0:
            raise RuntimeError("H3 CUDA history requires the native clean-at-one, seven-update sampler contract.")


def decode_history(source, interval, width, height):
    """Decode only the selected 24 fps frames and their absolute 32 kHz stereo interval."""
    import av
    import numpy as np

    frames = []
    origin = None
    with av.open(str(source)) as container:
        if not container.streams.video:
            raise RuntimeError("H3 history requires a video stream.")
        stream = container.streams.video[0]
        graph = av.filter.Graph()
        src = graph.add_buffer(template=stream)
        graph.link_nodes(src, graph.add("setpts", "PTS-STARTPTS"),
                         graph.add("fps", "fps=24:start_time=0"),
                         graph.add("scale", f"{width}:{height}"), graph.add("format", "rgb24"),
                         graph.add("buffersink"))
        graph.configure()
        index = 0

        def drain():
            nonlocal index
            while index < interval["end_frame"]:
                try:
                    frame = graph.pull()
                except (av.error.BlockingIOError, av.error.EOFError):
                    break
                if index >= interval["start_frame"]:
                    frames.append(frame.to_ndarray())
                index += 1

        for frame in container.decode(stream):
            if origin is None:
                if frame.pts is None:
                    raise RuntimeError("H3 history video needs timestamps for audio alignment.")
                origin = frame.pts * frame.time_base
            graph.push(frame)
            drain()
            if index >= interval["end_frame"]:
                break
        if index < interval["end_frame"]:
            graph.push(None)
            drain()
    if len(frames) != 17:
        raise RuntimeError("H3 history source ends before the selected 17-frame interval.")

    start, end = interval["start_sample"], interval["end_sample"]
    audio = np.zeros((2, end - start), dtype=np.float32)
    covered = np.zeros(end - start, dtype=bool)
    with av.open(str(source)) as container:
        if not container.streams.audio:
            raise RuntimeError("H3 history requires matching source audio.")
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=32000)

        def consume(frame):
            if frame.pts is None:
                raise RuntimeError("H3 history audio needs timestamps for alignment.")
            offset = round((frame.pts * frame.time_base - origin) * 32000)
            left, right = max(start, offset), min(end, offset + frame.samples)
            if right > left:
                audio[:, left - start:right - start] = frame.to_ndarray()[:, left - offset:right - offset]
                covered[left - start:right - start] = True
            return offset + frame.samples >= end

        done = False
        for frame in container.decode(container.streams.audio[0]):
            for normalized in resampler.resample(frame):
                done = consume(normalized) or done
            if done:
                break
        if not done:
            for normalized in resampler.resample(None):
                consume(normalized)
    if not covered.all():
        raise RuntimeError("H3 history source audio does not cover the exact selected interval.")
    return np.stack(frames), audio


def encode_history(pipe, frames, audio):
    import torch
    from diffusers.modular_pipelines.minimax_h3.encoders import encode_vae_condition

    if pipe.vae.config.clip_length != 17 or pipe.vae.config.token_drop != 3:
        raise RuntimeError("H3 CUDA history requires the pinned 17-frame video encoder geometry.")
    device = pipe._execution_device
    pixels = torch.from_numpy(frames).to(device).permute(3, 0, 1, 2)[None]
    # The normal VAE drops three trailing latents for standalone output. A full
    # history chunk needs all five. Keep encode()'s offload hook and restore its
    # output/decode configuration even when encoding fails.
    pipe.vae.register_to_config(token_drop=0)
    try:
        video = encode_vae_condition(pipe.vae, pixels, pipe.pixel_mean, pipe.pixel_std, pipe.keyframe_encode_seed)
    finally:
        pipe.vae.register_to_config(token_drop=3)
    del pixels
    if video.shape[2] != 5:
        raise RuntimeError("H3 CUDA history encoder did not produce five latent frames.")
    waveform = torch.from_numpy(audio).to(device)[:, None]
    posterior = pipe.audio_vae.encode(waveform, return_dict=False)[0]
    rows = posterior.mode().float().cpu().transpose(1, 2)
    mean = torch.tensor(pipe.audio_vae.config.latents_mean).view(1, 1, -1)
    std = torch.tensor(pipe.audio_vae.config.latents_std).view(1, 1, -1)
    rows = ((rows - mean) / std).reshape(-1, pipe.audio_latent_channels)
    return video, rows


def pack_history(pipe, state, video, audio):
    """Insert history before native target rows; keep target sizes for target-only decode."""
    import torch
    from diffusers.modular_pipelines.minimax_h3.before_denoise import (
        _fill_audio_positions, _frame_position_grid, _temporal_position_grid,
        patchify_video_latents, MiniMaxH3SetTimestepsStep,
    )

    device = pipe._execution_device
    history_video = patchify_video_latents(video, pipe.patch_size).to(device, torch.float32)
    history_audio = audio.to(device, torch.float32)
    nv, na = history_video.shape[0], history_audio.shape[0]
    nt = state.get("text_indices").numel()
    target_positions = state.get("position_ids")
    patch_t, patch_h, patch_w = pipe.patch_size
    if patch_t != 1 or video.shape[2:] != (5, state.get("latent_height"), state.get("latent_width")) or na % 2:
        raise RuntimeError("H3 CUDA history geometry differs from the pinned packing contract.")
    frame_grid, width_grid = _frame_position_grid(video.shape[3], video.shape[4], patch_h, patch_w)
    positions = torch.zeros((nt + na + nv + target_positions.shape[0] - nt, 3), dtype=torch.float64)
    positions[:nt] = target_positions[:nt].cpu()
    _fill_audio_positions(positions, slice(nt, nt + na), na // 2, float(nt), width_grid, 2)
    history_positions = positions[nt + na:nt + na + nv].reshape(5, -1, 3)
    history_positions[:, :, 0] = _temporal_position_grid(5, float(nt))[:, None]
    history_positions[:, :, 1:] = frame_grid[None]
    positions[nt + na + nv:] = target_positions[nt:].cpu()
    positions[nt + na + nv:, 0] += 17 * 40 / 24

    tags = torch.cat([state.get("token_tags")[:nt].cpu(),
                      torch.full((na,), pipe.audio_tag), torch.full((nv,), pipe.video_tag),
                      state.get("token_tags")[nt:].cpu()])
    video_indices = torch.cat([torch.arange(nt + na, nt + na + nv), state.get("video_indices").cpu() + na + nv])
    audio_indices = torch.cat([torch.arange(nt, nt + na), state.get("audio_indices").cpu() + na + nv])
    for name, value in {"position_ids": positions, "token_tags": tags,
                        "video_indices": video_indices, "audio_indices": audio_indices}.items():
        state.set(name, value.to(device), "denoiser_input_fields")
    state.set("latents", torch.cat([history_video, state.get("latents")]))
    state.set("audio_latents", torch.cat([history_audio, state.get("audio_latents")]))
    state.set("num_condition_video_rows", nv)
    state.set("num_condition_audio_rows", na)
    pipe.scheduler.set_timesteps(state.get("num_inference_steps"), device=device)
    pipe.audio_scheduler.set_timesteps(state.get("num_inference_steps"), device=device)
    state.set("timesteps", pipe.scheduler.timesteps)
    state.set("audio_timesteps", pipe.audio_scheduler.timesteps)
    state.set("row_timestep_plan", [
        tuple(value.to(device) for value in MiniMaxH3SetTimestepsStep.build_row_timesteps(
            video_indices, audio_indices, nv, na, nt, float(vt), float(at), 1.0, 1.0))
        for vt, at in zip(pipe.scheduler.timesteps, pipe.audio_scheduler.timesteps)
    ])


def run_history(pipe, args, frames, audio):
    import torch
    from diffusers.modular_pipelines.modular_pipeline import PipelineState
    from diffusers.modular_pipelines.minimax_h3.encoders import MiniMaxH3TextEncoderStep
    from diffusers.modular_pipelines.minimax_h3.before_denoise import MiniMaxH3PrepareLayoutStep, MiniMaxH3PrepareLatentsStep
    from diffusers.modular_pipelines.minimax_h3.denoise import MiniMaxH3DenoiseStep
    from diffusers.modular_pipelines.minimax_h3.decoders import (
        MiniMaxH3AfterDenoiseStep, MiniMaxH3VideoDecodeStep, MiniMaxH3AudioDecodeStep,
    )

    if pipe.scheduler.shift != 12 or pipe.audio_scheduler.shift != 3:
        raise RuntimeError("H3 CUDA history requires the baseline video/audio sampler shifts 12/3.")
    state = PipelineState()
    for key, value in {"prompt": args.prompt, "height": args.height, "width": args.width,
                       "num_frames": args.num_frames, "num_inference_steps": args.steps,
                       "generator": torch.Generator().manual_seed(args.seed), "keyframe_anchors": ()}.items():
        state.set(key, value)
    with torch.no_grad():
        for step in (MiniMaxH3TextEncoderStep, MiniMaxH3PrepareLayoutStep, MiniMaxH3PrepareLatentsStep):
            _, state = step()(pipe, state)
        video, audio_rows = encode_history(pipe, frames, audio)
        pack_history(pipe, state, video, audio_rows)
        for step in (MiniMaxH3DenoiseStep, MiniMaxH3AfterDenoiseStep, MiniMaxH3VideoDecodeStep, MiniMaxH3AudioDecodeStep):
            _, state = step()(pipe, state)
    return state.get(["videos", "audio", "sampling_rate"])


def mux_owned_output(output, encode, frames, audio, sampling_rate):
    """Publish without overwriting an existing clip; cleanup owns only its temporary directory."""
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if os.path.lexists(output):
        raise RuntimeError("H3 output already exists; choose a new output file.")
    with tempfile.TemporaryDirectory(prefix=".portos-h3-", dir=output.parent) as scratch:
        previous = {}

        def cancel(signum, _frame):
            raise SystemExit(128 + signum)

        try:
            for name in ("SIGTERM", "SIGBREAK"):
                sig = getattr(signal, name, None)
                if sig is not None:
                    previous[sig] = signal.signal(sig, cancel)
            target = Path(scratch) / "result.mp4"
            encode(frames, fps=24, output_path=str(target), audio=audio, audio_sample_rate=sampling_rate)
            if not target.is_file() or target.stat().st_size == 0:
                raise RuntimeError("H3 mux did not produce a complete video.")
            # Same filesystem, atomic no-clobber publication (also closes the
            # race between the initial existence check and a second producer).
            os.link(target, output)
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
