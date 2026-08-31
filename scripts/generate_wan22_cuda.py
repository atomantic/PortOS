#!/usr/bin/env python3
"""Cache-only Wan 2.2 TI2V 5B text-to-video runner for NVIDIA CUDA."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import emit_runtime_fingerprint, establish_process_group, heartbeat  # noqa: E402


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-repo", required=True)
    parser.add_argument("--model-revision", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--negative-prompt", default="")
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--num-frames", type=int, required=True)
    parser.add_argument("--fps", type=float, required=True)
    parser.add_argument("--steps", type=int, required=True)
    parser.add_argument("--guidance", type=float, required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if args.width % 16 or args.height % 16:
        raise SystemExit("Wan 2.2 width and height must be divisible by 16.")
    if args.num_frames < 5 or (args.num_frames - 1) % 4:
        raise SystemExit("Wan 2.2 frame count must satisfy 4n+1.")
    if args.steps < 1:
        raise SystemExit("Wan 2.2 steps must be positive.")


def main() -> None:
    establish_process_group()
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    args = parse_args()
    validate_args(args)
    from huggingface_hub import snapshot_download
    log("STAGE:resolve-cache")
    try:
        snapshot = snapshot_download(repo_id=args.model_repo, revision=args.model_revision, local_files_only=True)
    except Exception as exc:
        raise RuntimeError("The pinned Wan 2.2 snapshot is incomplete. Use Download or Repair in Video Gen.") from exc
    import torch
    from diffusers import AutoencoderKLWan, WanPipeline
    from diffusers.utils import export_to_video
    if not torch.cuda.is_available():
        raise RuntimeError("Wan 2.2 CUDA needs a visible NVIDIA device. Repair the runtime in Video Gen.")
    emit_runtime_fingerprint("wan22_cuda", ["torch", "diffusers", "transformers", "accelerate", "huggingface-hub", "hf-xet"])
    log("STATUS:Loading Wan 2.2 TI2V 5B with component CPU offload")
    log("STAGE:load-pipeline")
    with heartbeat("wan22-cuda-load"):
        vae = AutoencoderKLWan.from_pretrained(snapshot, subfolder="vae", torch_dtype=torch.float32, local_files_only=True)
        pipe = WanPipeline.from_pretrained(snapshot, vae=vae, torch_dtype=torch.bfloat16, local_files_only=True)
        # Each component fits independently on a 24 GB card (the largest is
        # the ~20 GB transformer). Model-level offload moves each component
        # once; sequential offload moved every layer every step and made a
        # 3090 needlessly slow without lowering the peak that matters here.
        pipe.enable_model_cpu_offload()
        pipe.vae.enable_tiling()
    generator = torch.Generator(device="cpu").manual_seed(args.seed)
    log("STAGE:inference")
    with heartbeat("wan22-cuda-inference"):
        frames = pipe(prompt=args.prompt, negative_prompt=args.negative_prompt or None, height=args.height, width=args.width, num_frames=args.num_frames, num_inference_steps=args.steps, guidance_scale=args.guidance, generator=generator).frames[0]
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    log("STAGE:mux")
    export_to_video(frames, str(output), fps=int(args.fps))
    if not output.is_file():
        raise RuntimeError(f"Wan 2.2 completed but did not write {output}.")
    log(f"STATUS:Wan 2.2 saved {output.name} ({len(frames)} frames)")


if __name__ == "__main__":
    main()
