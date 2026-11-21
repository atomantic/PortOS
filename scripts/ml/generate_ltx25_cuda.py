#!/usr/bin/env python3
"""Cache-only LTX-2.5 distilled video+audio runner for NVIDIA CUDA.

The Video Gen UI owns runtime installation and every Hugging Face download.
This helper resolves the pinned split checkpoint only from the local cache,
streams model blocks from disk on consumer GPUs, and writes one MP4.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import emit_runtime_fingerprint, establish_process_group, heartbeat  # noqa: E402


MODEL_FILES = {
    "transformer": "diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors",
    "text_encoder": "text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors",
    "video_vae": "vae/ltx-2.5-video-vae-bf16.safetensors",
    "audio_vae": "vae/ltx-2.5-audio-vae-bf16.safetensors",
    "duration_head": "model_patches/ltx-2.5-duration-head-bf16.safetensors",
    "upsampler": "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
}


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-repo", required=True)
    parser.add_argument("--model-revision", required=True)
    parser.add_argument("--repo-file", action="append", default=[])
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--negative-prompt")
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--num-frames", type=int, required=True)
    parser.add_argument("--fps", type=float, required=True)
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--image")
    parser.add_argument("--image-strength", type=float, default=1.0)
    parser.add_argument("--disable-audio", action="store_true")
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    missing = sorted(set(MODEL_FILES.values()) - set(args.repo_file))
    if missing:
        raise SystemExit(f"LTX-2.5 model entry is missing required repo files: {', '.join(missing)}")
    if args.width % 64 or args.height % 64:
        raise SystemExit("The two-stage LTX-2.5 pipeline requires width and height divisible by 64.")
    if args.num_frames < 9 or args.num_frames % 8 != 1:
        raise SystemExit("LTX-2.5 num-frames must be at least 9 and satisfy frames % 8 == 1.")
    if args.steps != 8:
        raise SystemExit("The distilled LTX-2.5 schedule is fixed at 8 steps.")
    if not 0 <= args.image_strength <= 1:
        raise SystemExit("image-strength must be between 0 and 1.")


def resolve_snapshot(args: argparse.Namespace) -> Path:
    from huggingface_hub import snapshot_download

    try:
        root = snapshot_download(
            repo_id=args.model_repo,
            revision=args.model_revision,
            allow_patterns=args.repo_file,
            local_files_only=True,
        )
    except Exception as exc:
        raise RuntimeError(
            "The pinned LTX-2.5 files are not complete in the Hugging Face cache. "
            "Use Download or Repair on the Video Gen page."
        ) from exc
    snapshot = Path(root)
    unresolved = [relative for relative in MODEL_FILES.values() if not (snapshot / relative).is_file()]
    if unresolved:
        raise RuntimeError(
            "The pinned LTX-2.5 snapshot is incomplete: " + ", ".join(unresolved)
        )
    return snapshot


def main() -> None:
    establish_process_group()
    args = parse_args()
    validate_args(args)
    log("STAGE:resolve-cache")
    snapshot = resolve_snapshot(args)

    # LTX's documented allocator setting reduces fragmentation on cards that
    # sit close to the model's supported VRAM floor. It must be set before
    # importing torch so CUDA reads it during allocator initialization.
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    import torch
    from ltx_core.model.video_vae import AUTO_TILING, get_video_chunks_number
    from ltx_core.quantization.fp8_cast import build_policy as build_fp8_cast_policy
    from ltx_pipelines.distilled import DistilledPipeline
    from ltx_pipelines.utils.args import ImageConditioningInput
    from ltx_pipelines.utils.media_io import encode_video
    from ltx_pipelines.utils.model_paths import ModelPaths
    from ltx_pipelines.utils.types import OffloadMode

    if not torch.cuda.is_available():
        raise RuntimeError("LTX-2.5 CUDA needs a visible NVIDIA device. Repair the runtime from Video Gen.")
    emit_runtime_fingerprint(
        "ltx25_cuda",
        ["torch", "ltx-core", "ltx-pipelines", "transformers", "accelerate", "huggingface-hub"],
    )
    paths = {key: str(snapshot / relative) for key, relative in MODEL_FILES.items()}
    model_paths = ModelPaths.from_split(
        transformer_path=paths["transformer"],
        text_encoder_path=paths["text_encoder"],
        video_vae_path=paths["video_vae"],
        audio_vae_path=paths["audio_vae"],
        duration_head_path=paths["duration_head"],
    )

    log("STATUS:LTX-2.5 CUDA disk-streamed loading (FP8 transformer cache)")
    log("STAGE:load-pipeline")
    with heartbeat("ltx25-cuda-load"):
        pipe = DistilledPipeline(
            model_paths=model_paths,
            spatial_upsampler_path=paths["upsampler"],
            loras=[],
            device=torch.device("cuda"),
            quantization=build_fp8_cast_policy(paths["transformer"]),
            # CPU mode pins a model-sized prefetch buffer. The 24 GB VRAM /
            # 32 GB system-RAM tier can exhaust that buffer while Gemma is
            # resident; DISK is upstream's lowest-memory streaming mode.
            offload_mode=OffloadMode.DISK,
        )
    images = []
    if args.image:
        images.append(ImageConditioningInput(args.image, 0, args.image_strength))
    log("STAGE:inference")
    with heartbeat("ltx25-cuda-inference"):
        video, audio, resolved_frames, tiling = pipe(
            prompt=args.prompt,
            seed=args.seed,
            height=args.height,
            width=args.width,
            num_frames=args.num_frames,
            frame_rate=args.fps,
            images=images,
            tiling_config=AUTO_TILING,
        )
    if args.disable_audio:
        audio = None

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    log("STAGE:mux")
    encode_video(
        video=video,
        fps=int(args.fps),
        audio=audio,
        output_path=str(output),
        video_chunks_number=int(get_video_chunks_number(resolved_frames, tiling)),
    )
    if not output.is_file():
        raise RuntimeError(f"LTX-2.5 completed but did not write {output}.")
    log(f"STATUS:LTX-2.5 saved {output.name} ({resolved_frames} frames)")


if __name__ == "__main__":
    main()
