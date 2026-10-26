"""PortOS-owned, experimental history adapter for one byte-verified MLX pin.

No reference runner is imported or executed. Only target rows are denoised and
decoded; clean prior rows sit before the target on H3's shared 40 Hz clock.
Automatic capability stays disabled until a paired moving-subject render is
inspected. Deterministic tensor fixtures are not evidence of visual fidelity.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

PIN = "fcd9e9b79a1d6018d91ac477c0968de1fa067e49"
UNAVAILABLE_REASON = "H3 MLX history motion/audio fidelity has no inspected paired hardware render."
SOURCE_DIGESTS = {
    "adaln.py": "4aa45f392b6e61c10698480382112c5e17de489aebebbcf11e384d7347305e27",
    "audio_vae.py": "eedab45ed5afc63e27464fd106bf42f015039f4e76f7a0e0e1a9d62c06b9bcaf",
    "config.py": "9992a243a374ede1e072f6211652875d5985eacf82a76e4301162e4fcd9dee9f",
    "dit.py": "f2abcdf88c795775ea24946aed30413b305695c1aa575662d450eceb1d65e2ae",
    "load.py": "18497a2c7440ff0aace310a5338294a6074bc5e4c4ef588dd7481654e83a434b",
    "packing.py": "dcbe3dc75ca03879fbd2142ac22f7b133822061d4c3bc17473f26b3294e3ff54",
    "pipeline.py": "99ec295258ece66d0076838bf29e7eb3b0a1a20f5e8d401739459fcd054e0bc1",
    "scheduler.py": "3966866aeba746fa79a64b9d598e312d8445b56a11380fdaf23bf908f1dce063",
    "video_vae.py": "ac80d5826fcf936635eb75f51578447d65c14410e236f357e67eca3a2c60c08a",
}


def verify_history_backend(runtime_dir: Path, revision: str) -> None:
    """Verify executable seams without importing MLX or loading any weights."""
    if revision != PIN:
        raise RuntimeError("H3 MLX history unavailable: unsupported runtime revision; update the PortOS adapter.")
    for name, digest in SOURCE_DIGESTS.items():
        path = runtime_dir / "minimax_h3_mlx" / name
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError(f"H3 MLX history unavailable: pinned {name} seam differs; use Repair in Video Gen.")


def read_history_media(args, interval: dict, ffmpeg: str):
    """Decode exactly the prior interval; never write beside the source."""
    import numpy as np

    source = str(Path(args.source_video).resolve())
    common = [ffmpeg, "-v", "error", "-nostdin", "-i", source]
    video = subprocess.run(common + [
        "-map", "0:v:0", "-vf",
        f"fps=24,trim=start_frame={interval['start_frame']}:end_frame={interval['end_frame']},"
        f"setpts=PTS-STARTPTS,scale={args.width}:{args.height}:flags=lanczos,setsar=1",
        "-frames:v", "17", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ], capture_output=True, check=True)
    audio = subprocess.run(common + [
        "-map", "0:a:0", "-af",
        f"aresample=32000,atrim=start_sample={interval['start_sample']}:end_sample={interval['end_sample']}",
        "-ac", "2", "-f", "f32le", "pipe:1",
    ], capture_output=True, check=True)
    samples = interval["end_sample"] - interval["start_sample"]
    if len(video.stdout) != 17 * args.width * args.height * 3 or len(audio.stdout) != samples * 2 * 4:
        raise RuntimeError("H3 history source does not cover the requested video/audio interval.")
    frames = np.frombuffer(video.stdout, dtype=np.uint8).reshape(17, args.height, args.width, 3)
    waveform = np.frombuffer(audio.stdout, dtype="<f4").reshape(-1, 2).T.copy()
    if not np.isfinite(waveform).all():
        raise RuntimeError("H3 history source audio contains non-finite samples.")
    return frames, waveform


def encode_history(pipe, frames, waveform):
    import mlx.core as mx
    import numpy as np
    from minimax_h3_mlx.packing import KEYFRAME_ENCODE_SEED, PIXEL_MEAN, PIXEL_STD, patchify_video_latents

    if frames.ndim != 4 or frames.shape[0] != 17 or frames.shape[-1] != 3:
        raise RuntimeError("H3 history requires exactly 17 RGB pixel frames.")
    if waveform.ndim != 2 or waveform.shape[0] != 2 or waveform.shape[1] not in (22666, 22667):
        raise RuntimeError("H3 history requires the matching 17/24-second stereo interval.")
    cfg = pipe.video_vae.config
    if (cfg.clip_length, cfg.token_drop, tuple(pipe.dit.config.patch_size)[0]) != (17, 3, 1):
        raise RuntimeError("H3 MLX history unavailable: incompatible VAE chunk or temporal patch geometry.")
    if (pipe.audio_vae.config.sampling_rate, pipe.audio_vae.config.hop_length) != (32000, 800):
        raise RuntimeError("H3 MLX history unavailable: incompatible audio clock.")
    pixels = frames.astype(np.float32) / 255.0
    pixels = (pixels - np.array(PIXEL_MEAN, dtype=np.float32)) / np.array(PIXEL_STD, dtype=np.float32)
    # One complete 17-frame encoder chunk has five latent frames. The public
    # encode drops its last three for *decoding* overlap; history is never
    # decoded, so retain the complete chunk rather than losing its newest motion.
    moments = pipe.video_vae._encode_clip(mx.array(pixels[None].astype(np.float32)))
    channels = cfg.latent_channels
    mean, logvar = moments[..., :channels], moments[..., channels:]
    mx.random.seed(KEYFRAME_ENCODE_SEED)
    latent = mean + mx.exp(0.5 * mx.clip(logvar, -30.0, 20.0)) * mx.random.normal(mean.shape)
    latent = latent.transpose(0, 4, 1, 2, 3).astype(mx.float16).astype(mx.float32)
    vm = mx.array(cfg.latents_mean).reshape(1, -1, 1, 1, 1)
    vs = mx.array(cfg.latents_std).reshape(1, -1, 1, 1, 1)
    video_rows = patchify_video_latents((latent - vm) / vs, pipe.dit.config.patch_size)

    audio, _ = pipe.audio_vae.encode(mx.array(waveform[:, None, :]))
    ac = pipe.audio_vae.config
    am = mx.array(ac.latents_mean).reshape(1, -1, 1)
    ast = mx.array(ac.latents_std).reshape(1, -1, 1)
    audio = (audio - am) / ast
    if latent.shape[2] != 5 or audio.shape[0] != 2 or audio.shape[2] != 29:
        raise RuntimeError("H3 MLX history unavailable: encoder returned an unexpected history shape.")
    return video_rows, audio.transpose(0, 2, 1).reshape(-1, ac.latent_channels)


def history_layout(tags, latent_frames, height, width, audio_frames, patch):
    """Use the pin's spatial/temporal grids, offsetting the target by 17/24 s."""
    import mlx.core as mx
    import numpy as np
    from minimax_h3_mlx.config import TAG_AUDIO, TAG_VIDEO
    from minimax_h3_mlx.packing import PackedSequence, build_packed_sequence, _temporal_position_grid

    target = build_packed_sequence(tags, latent_frames, height, width, audio_frames, patch)
    prior = build_packed_sequence([], 5, height, width, 29, patch)
    text_count = len(tags)
    tv, ta = np.array(target.video_indices), np.array(target.audio_indices)
    hv, ha = np.array(prior.video_indices), np.array(prior.audio_indices)
    tp, hp = np.array(target.position_ids).astype(np.float64), np.array(prior.position_ids).astype(np.float64)
    # Rebuild temporal coordinates in the pin's float64 host arithmetic before
    # the final cast; adding an offset to its finished float32 grid loses ulps.
    rows_per_frame = len(tv) // latent_frames
    origin = float(text_count)
    target_origin = origin + 17 * 40 / 24
    hp[hv, 0] = np.repeat(_temporal_position_grid(5, origin), rows_per_frame)
    hp[ha, 0] = np.tile(origin + np.arange(29, dtype=np.float64), 2)
    tp[tv, 0] = np.repeat(_temporal_position_grid(latent_frames, target_origin), rows_per_frame)
    tp[ta, 0] = np.tile(target_origin + np.arange(audio_frames, dtype=np.float64), 2)
    positions = np.concatenate([tp[:text_count], hp[ha], tp[ta], hp[hv], tp[tv]])
    audio_start = text_count
    video_start = audio_start + len(ha) + len(ta)
    length = len(positions)
    token_tags = np.concatenate([np.array(tags), np.full(len(ha) + len(ta), TAG_AUDIO),
                                 np.full(len(hv) + len(tv), TAG_VIDEO)]).astype(np.int32)
    return PackedSequence(
        sequence_length=length, position_ids=mx.array(positions.astype(np.float32)),
        token_tags=mx.array(token_tags), text_indices=mx.array(np.arange(text_count, dtype=np.int32)),
        video_indices=mx.array(np.arange(video_start, length, dtype=np.int32)),
        audio_indices=mx.array(np.arange(audio_start, video_start, dtype=np.int32)),
        num_condition_video_rows=len(hv), num_condition_audio_rows=len(ha),
    )


def render_history(pipe, args, history, seed: int):
    """Direct fixture boundary: supplied pixels/audio, real packed denoise path."""
    import mlx.core as mx
    import numpy as np
    from minimax_h3_mlx.packing import audio_latent_num_frames, build_row_timesteps, patchify_video_latents, video_latent_num_frames

    embeddings, tags = pipe.text_encoder.encode(args.prompt, None)
    cfg = pipe.video_vae.config
    height, width = args.height // cfg.spatial_compression_ratio, args.width // cfg.spatial_compression_ratio
    frames = video_latent_num_frames(args.num_frames)
    audio_frames = audio_latent_num_frames(args.num_frames)
    prior_video, prior_audio = encode_history(pipe, *history)
    layout = history_layout(tags, frames, height, width, audio_frames, pipe.dit.config.patch_size)
    nv, na = layout.num_condition_video_rows, layout.num_condition_audio_rows
    if len(prior_video) != nv or len(prior_audio) != na:
        raise RuntimeError("H3 MLX history rows do not match the pinned packing layout.")
    mx.random.seed(seed)
    video = patchify_video_latents(mx.random.normal((1, cfg.latent_channels, frames, height, width)), pipe.dit.config.patch_size)
    audio = mx.random.normal((audio_frames * 2, pipe.audio_vae.config.latent_channels))
    video = mx.concatenate([prior_video, video])
    audio = mx.concatenate([prior_audio, audio])
    vs, aus = pipe._build_schedules(args.steps)
    # H3 uses data-ward t: 1.0 is fully clean. Unlike FL2VA anchors, history
    # receives no 0.999 augmentation and is excluded from every Euler update.
    assignments = [build_row_timesteps(layout, float(v), float(a), 1.0, 1.0)
                   for v, a in zip(vs.timesteps.tolist(), aus.timesteps.tolist())]
    table = sorted({float(t) for distinct, _ in assignments for t in distinct.tolist()})
    lookup = {t: i for i, t in enumerate(table)}
    plans = [mx.array(np.array([lookup[float(t)] for t in distinct.tolist()], dtype=np.int32)[np.array(indices)])
             for distinct, indices in assignments]
    timesteps = mx.array(table, dtype=mx.float32)
    pipe._ensure_cache(timesteps, True, True)
    for step, t in enumerate(vs.timesteps.tolist()):
        vp, ap = pipe.dit(video[None].astype(mx.bfloat16), audio[None].astype(mx.bfloat16),
                          embeddings.astype(mx.bfloat16), timesteps, plans[step], layout.token_tags,
                          layout.position_ids, layout.video_indices, layout.audio_indices, layout.text_indices,
                          modulation_cache=pipe._cache)
        video = mx.concatenate([prior_video, vs.step(vp[0, nv:].astype(mx.float32), float(t), video[nv:])])
        audio = mx.concatenate([prior_audio, aus.step(ap[0, na:].astype(mx.float32), float(aus.timesteps[step].item()), audio[na:])])
        mx.eval(video, audio)
        print(f"step {step + 1}/{len(plans)}", flush=True)
    return SimpleNamespace(video=pipe._decode_video(video[nv:], frames, height, width),
                           audio=pipe._decode_audio(audio[na:], audio_frames), fps=24,
                           sample_rate=pipe.audio_vae.config.sampling_rate)


def report_history(interval: dict) -> None:
    print("H3_HISTORY:" + json.dumps({**interval, "runtimeRevision": PIN, "automaticCapability": False,
                                     "unavailableReason": UNAVAILABLE_REASON}), flush=True)
