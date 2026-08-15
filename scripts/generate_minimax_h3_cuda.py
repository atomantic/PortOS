#!/usr/bin/env python3
"""Cache-only PortOS runner for MiniMax H3 on CUDA (Windows / Linux NVIDIA).

The CUDA sibling of `generate_minimax_h3.py`. Where that helper drives
PipeNetwork's pinned Apple-Silicon MLX port, this one drives diffusers'
`MiniMaxH3ModularPipeline` — the upstream integration, which is the only H3
path an NVIDIA box has. The two present the SAME CLI to PortOS (`--prompt`,
geometry, `--image` / `--anchor` pairs, `--output`) and emit the same
STAGE:/STATUS:/RUNTIME: progress frames, so `local.js` differs only in which
binary and helper it spawns.

The Video Gen UI owns every network operation. This helper resolves only the
exact revision already present in Hugging Face's cache, loads the diffusers
`fl2va` workflow from it, and writes one joint video-and-audio MP4.

Conditioning is H3's own `fl2va` keyframe path: zero images is text-to-video,
one `--image first` is image-to-video, and a `first` + `last` pair is FFLF.
Each `--image` needs its own `--anchor`, in the same order.

Memory: the bf16 components are 66.3 GB (transformer) + 66.7 GB (Qwen3-VL
conditioner), so nothing fits on a consumer card unquantized. The offload
profiles below are the recipes upstream documents, chosen from the card's own
VRAM unless `--offload-profile` pins one.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import emit_runtime_fingerprint, establish_process_group, heartbeat  # noqa: E402
from _minimax_h3_common import (  # noqa: E402
    FPS, add_h3_common_args, emit_result, load_keyframes, resolve_cached_snapshot,
    validate_h3_output_args,
)


# The diffusers integration snaps `num_frames` up to the next 17n+5 the video
# VAE can decode and then requires the RESULTING duration to land in 5-15 s.
# That is narrower than the MLX port's 4-15 s at both ends, so these bounds are
# deliberately not shared with generate_minimax_h3.py — the matching list is
# MINIMAX_H3_CUDA_FRAME_OPTIONS in server/lib/mediaModels.js.
MIN_FRAMES = 124  # first 17n+5 grid point at or above 5 seconds
MAX_FRAMES = 345  # last 17n+5 grid point at or below 15 seconds
OFFLOAD_PROFILES = ("auto", "bf16", "int8-stream", "int8-lean")

# int8 weight-only quantization must skip the projection / embedding / norm
# layers on each component — they are small, numerically sensitive, and
# quantizing them is what degrades the output rather than saving memory. These
# two lists are upstream's documented `modules_to_not_convert` sets.
TRANSFORMER_KEEP_BF16 = [
    "proj_in", "audio_proj_in", "context_embedder", "time_embedder", "time_proj",
    "token_refiner", "norm_out", "proj_out", "audio_proj_out",
]
TEXT_ENCODER_KEEP_BF16 = [
    "model.visual",
    "model.language_model.embed_tokens",
    "model.language_model.norm",
    "lm_head",
]


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def parse_args() -> argparse.Namespace:
    parser = add_h3_common_args(argparse.ArgumentParser(description=__doc__), steps_default=8)
    parser.add_argument("--repo-file", action="append", default=[],
                        help="repo-relative diffusers component file that must already be cached (repeatable)")
    parser.add_argument("--offload-profile", choices=OFFLOAD_PROFILES, default="auto",
                        help="weight-placement recipe; 'auto' sizes one from the visible CUDA device")
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    # Everything the H3 checkpoint imposes regardless of runtime — fps, the 32px
    # canvas grid, the 17n+5 frame grid, the sigma floor, keyframe anchoring —
    # lives in the shared module so this runner and the MLX one cannot drift.
    # Only the duration window and the file-list requirement below are ours.
    validate_h3_output_args(
        args,
        min_frames=MIN_FRAMES,
        max_frames=MAX_FRAMES,
        frame_window_message=(
            f"MiniMax H3 on diffusers supports 5-15 seconds "
            f"({MIN_FRAMES}-{MAX_FRAMES} aligned frames); got {args.num_frames}."
        ),
    )
    if not args.repo_file:
        raise SystemExit("MiniMax H3 needs its pinned component file list (--repo-file).")


def resolve_offload_profile(requested: str) -> str:
    """Pick a weight-placement recipe from the visible CUDA device's VRAM.

    An explicit request always wins — the registry entry can pin one, and a user
    who knows their box better than a capacity heuristic does should not be
    overridden. 'auto' is the default because the entry is shared across every
    install that syncs it and cannot know what GPU is on the other end.
    """
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError(
            "MiniMax H3 CUDA needs a visible NVIDIA device. Repair the MiniMax H3 CUDA runtime from Video Gen."
        )
    if requested != "auto":
        return requested
    total_gb = torch.cuda.get_device_properties(0).total_memory / 1e9
    # 60 GB is the floor for holding one bf16 component resident while the
    # manager swaps the other; below it, int8 is the only thing that fits.
    # 20 GB is where streamed block-level offload stops fitting a block plus
    # its activations, and the leaner leaf-level recipe takes over.
    if total_gb >= 60:
        return "bf16"
    return "int8-stream" if total_gb >= 20 else "int8-lean"


def load_pipeline(snapshot: Path, profile: str):
    """Load the `fl2va` workflow under one of the documented memory recipes.

    `fl2va` covers text-to-video too (it is the same `transformer/` partition),
    so one workflow serves every mode PortOS exposes and the 66 GB
    `transformer_ref/` partition is never loaded — which is also why it is
    absent from the model entry's download list.
    """
    import torch
    from diffusers import ComponentsManager, ModularPipeline

    if profile == "bf16":
        manager = ComponentsManager()
        pipe = ModularPipeline.from_pretrained(str(snapshot), components_manager=manager)
        pipe.load_components(workflow="fl2va", dtype=torch.bfloat16)
        manager.enable_auto_cpu_offload(device="cuda", memory_reserve_margin="12GB")
        return pipe

    from diffusers import MiniMaxH3Transformer3DModel, TorchAoConfig
    from diffusers.hooks import apply_group_offloading
    from torchao.quantization import Int8WeightOnlyConfig
    from transformers import Qwen3VLForConditionalGeneration
    from transformers import TorchAoConfig as TransformersTorchAoConfig

    pipe = ModularPipeline.from_pretrained(str(snapshot))
    pipe.update_components(
        transformer=MiniMaxH3Transformer3DModel.from_pretrained(
            str(snapshot), subfolder="transformer", dtype=torch.bfloat16,
            quantization_config=TorchAoConfig(
                Int8WeightOnlyConfig(version=2),
                modules_to_not_convert=TRANSFORMER_KEEP_BF16,
            ),
            low_cpu_mem_usage=False,
        ),
        text_encoder=Qwen3VLForConditionalGeneration.from_pretrained(
            str(snapshot), subfolder="text_encoder", dtype=torch.bfloat16,
            quantization_config=TransformersTorchAoConfig(
                Int8WeightOnlyConfig(version=2),
                modules_to_not_convert=TEXT_ENCODER_KEEP_BF16,
            ),
        ),
    )
    pipe.load_components(workflow="fl2va", dtype=torch.bfloat16)

    # version=2 int8 tensors are pinnable, which streamed offload needs, and
    # freezing removes the one autograd path the quantized tensors cannot serve.
    pipe.transformer.requires_grad_(False)
    pipe.text_encoder.requires_grad_(False)

    stream = profile == "int8-stream"
    offload = dict(
        onload_device=torch.device("cuda"),
        offload_device=torch.device("cpu"),
        use_stream=stream,
    )
    pipe.transformer.enable_group_offload(
        offload_type="block_level", num_blocks_per_group=1, **offload
    )
    apply_group_offloading(pipe.text_encoder.model, offload_type="leaf_level", **offload)
    if stream:
        pipe.vae.to("cuda")
    else:
        # On a 12-16 GB card the video VAE no longer fits beside the streamed
        # transformer blocks, so it is offloaded leaf-by-leaf as well.
        apply_group_offloading(pipe.vae, offload_type="leaf_level", **offload)
    pipe.audio_vae.to("cuda")
    return pipe


def keyframe_kwargs(images: list, anchors: list[str]) -> dict:
    """Map PortOS's (image, anchor) pairs onto the blocks' two keyframe inputs."""
    return {
        {"first": "image", "last": "last_image"}[anchor]: image
        for image, anchor in zip(images, anchors)
    }


def main() -> int:
    args = parse_args()
    validate_args(args)
    # Read the keyframes first: everything below is ~60 HF cache lookups and a
    # torch/diffusers import, so an unreadable conditioning image should not
    # cost seconds before it reports.
    images = load_keyframes(args.image)

    establish_process_group()

    # No ffmpeg preflight here, unlike the MLX runner: that one shells out to the
    # binary to mux, while this one muxes in-process through diffusers'
    # encode_video(), which is backed by the pinned PyAV wheel. Gating on
    # `shutil.which("ffmpeg")` would fail every render on a box where PortOS
    # itself is happy — server/lib/ffmpeg.js deliberately falls back to
    # C:\ffmpeg\bin and Program Files rather than requiring it on PATH.

    # Resolve the cache BEFORE importing torch. The lookups are pure
    # huggingface_hub path arithmetic against a pinned commit — no network, no
    # metadata fetch — so an undownloaded model reports "use Download in Video
    # Gen" immediately instead of after a multi-second torch import.
    log("STAGE:resolve-cache")
    snapshot = resolve_cached_snapshot(args.model_repo, args.model_revision, args.repo_file)

    import torch

    emit_runtime_fingerprint(
        "minimax_h3_cuda",
        ["torch", "diffusers", "transformers", "torchao", "accelerate", "huggingface-hub"],
        extra_versions={"cuda": getattr(torch.version, "cuda", None)},
    )

    profile = resolve_offload_profile(args.offload_profile)
    log(f"STATUS:MiniMax H3 CUDA offload profile: {profile}")

    log("STAGE:load-pipeline")
    with heartbeat("minimax-h3-cuda-load"):
        pipe = load_pipeline(snapshot, profile)

    # No explicit step callback: a ModularPipeline validates its inputs by
    # name against the workflow's declared set, and `callback_on_step_end` is
    # not one of them. The denoise loop's own tqdm bar goes to stderr, which
    # PortOS's line handler already parses into progress frames
    # (`makeVideoGenLineHandler`'s `NN%|` branch) — same as every other runner
    # that leaves progress to tqdm.
    log("STAGE:inference")
    with heartbeat("minimax-h3-cuda-inference"):
        results = pipe(
            prompt=args.prompt,
            num_frames=args.num_frames,
            height=args.height,
            width=args.width,
            num_inference_steps=args.steps,
            # A CPU generator keeps the three documented draws (conditioning,
            # video, audio) reproducible regardless of which device each
            # component happens to be resident on under an offload profile.
            generator=torch.Generator().manual_seed(args.seed),
            output=["videos", "audio", "sampling_rate"],
            **keyframe_kwargs(images, args.anchor),
        )

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    log("STAGE:mux")
    from diffusers.utils.export_utils import encode_video

    frames = results["videos"][0]
    encode_video(
        frames,
        fps=FPS,
        output_path=str(output),
        audio=results["audio"][0],
        audio_sample_rate=results["sampling_rate"],
    )

    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError(f"MiniMax H3 completed but did not write {output}.")
    log(f"STATUS:MiniMax H3 saved {output.name} ({len(frames)} frames with stereo audio)")
    emit_result(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
