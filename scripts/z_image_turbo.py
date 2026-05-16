#!/usr/bin/env python3
"""
PortOS Z-Image-Turbo runner.

Spawned by `server/services/imageGen/local.js` when the active model has
`runner: 'z-image'` in `data/media-models.json`. Mirrors the CLI surface of
`flux2_macos.py` so the dispatcher only needs to swap the binary path; all
the SSE / stage-marker / stepwise / cancel plumbing on the JS side stays the
same.

Z-Image-Turbo (Tongyi/Alibaba) is Apache 2.0 — no HF token / license probe
needed. Runs on MPS (Apple Silicon) or CUDA via diffusers. Reuses the FLUX.2
venv at ~/.portos/venv-flux2 (already has diffusers from git HEAD + torch).
"""

import argparse
import inspect
import os
import sys
from pathlib import Path

os.environ.setdefault("PYTORCH_MPS_FAST_MATH", "1")

import torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import (  # noqa: E402
    apply_memory_optimizations,
    heartbeat,
    install_hf_error_handler,
    make_generator,
    make_stepwise_callback,
    pick_device,
    write_sidecar,
)
from lora_utils import apply_loras  # noqa: E402


def load_pipeline(repo: str, device: str, dtype, pipeline_class: str = ""):
    # When the registry pins a pipeline class (e.g. ErnieImagePipeline,
    # which isn't yet in AutoPipelineForText2Image's registry) load it
    # directly. Falls back to AutoPipelineForText2Image so Z-Image-Turbo
    # and any future registered model continues to work without a flag.
    import diffusers

    print(f"STAGE:download-pipeline:{repo}", file=sys.stderr, flush=True)
    print(f"🔧 diffusers runner: pipeline ← {repo} (class={pipeline_class or 'auto'})", file=sys.stderr)
    with heartbeat("loading-pipeline"):
        if pipeline_class:
            cls = getattr(diffusers, pipeline_class, None)
            if cls is None:
                print(f"❌ Unknown diffusers pipeline class: {pipeline_class}", file=sys.stderr)
                sys.exit(2)
            pipe = cls.from_pretrained(repo, torch_dtype=dtype, low_cpu_mem_usage=True)
        else:
            from diffusers import AutoPipelineForText2Image
            pipe = AutoPipelineForText2Image.from_pretrained(
                repo,
                torch_dtype=dtype,
                low_cpu_mem_usage=True,
            )
    print("STAGE:move-to-device", file=sys.stderr, flush=True)
    with heartbeat("move-to-device"):
        pipe.to(device)
    return pipe


def to_i2i_pipeline(pipe):
    # AutoPipelineForImage2Image.from_pipe reuses the loaded weights — no
    # second download. If the loaded pipeline class has no registered i2i
    # sibling, this raises and we fall back to txt2img.
    from diffusers import AutoPipelineForImage2Image
    return AutoPipelineForImage2Image.from_pipe(pipe)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="PortOS Z-Image-Turbo runner")
    p.add_argument("--model", required=True, help="model id (e.g. z-image-turbo-bf16)")
    p.add_argument("--repo", required=True, help="HF repo for the pipeline weights")
    p.add_argument("--prompt", required=True)
    p.add_argument("--negative-prompt", default="")
    p.add_argument("--width", type=int, default=1024)
    p.add_argument("--height", type=int, default=1024)
    p.add_argument("--steps", type=int, default=8)
    p.add_argument("--guidance", type=float, default=1.0)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--output", required=True)
    p.add_argument("--metadata", action="store_true", help="write <output>.metadata.json sidecar")
    p.add_argument("--image-path", default=None, help="optional init image for i2i")
    p.add_argument("--image-strength", type=float, default=None, help="0..1 i2i denoise strength")
    p.add_argument("--stepwise-image-output-dir", default=None)
    p.add_argument("--device", default="auto", choices=["auto", "mps", "cuda", "cpu"])
    p.add_argument("--lora-paths", nargs="*", default=[], help="absolute paths to LoRA .safetensors files")
    p.add_argument("--lora-scales", nargs="*", default=[], help="scale per LoRA, parallel to --lora-paths")
    p.add_argument("--pipeline-class", default="", help="optional explicit diffusers pipeline class (e.g. ErnieImagePipeline)")
    p.add_argument("--use-pe", action="store_true", help="enable the prompt enhancer (ERNIE-Image's use_pe kwarg)")
    return p.parse_args()


@install_hf_error_handler
def main() -> None:
    args = parse_args()

    device = pick_device(args.device)
    dtype = torch.bfloat16 if device in ("mps", "cuda") else torch.float32

    pipe = load_pipeline(args.repo, device, dtype, pipeline_class=args.pipeline_class)

    init_image = None
    if args.image_path:
        init_image = Image.open(args.image_path).convert("RGB").resize(
            (int(args.width), int(args.height)), Image.LANCZOS
        )
        # Promote the txt2img pipe to its i2i sibling. If the model family
        # doesn't expose an i2i variant, fall through to txt2img with a warning
        # — better than failing the request outright.
        try:
            pipe = to_i2i_pipeline(pipe)
        except Exception as err:
            print(
                f"⚠️ z-image: i2i sibling unavailable ({type(err).__name__}: {err}); "
                f"falling back to txt2img and ignoring init image",
                file=sys.stderr,
            )
            init_image = None

    apply_memory_optimizations(pipe)
    apply_loras(pipe, args.lora_paths or [], args.lora_scales or [])

    seed = args.seed if args.seed is not None else int(torch.randint(0, 2**31 - 1, (1,)).item())
    generator = make_generator(device, seed)

    # ERNIE keeps latents 2x2 patch-packed during the loop (e.g. 32→128 ch at
    # half spatial) and decodes via vae.bn unnormalization + _unpatchify_latents
    # before vae.decode — the generic scaling/shift path fails with a channel
    # mismatch ([32,32,1,1] weight vs 128-ch input). When the loaded pipeline
    # exposes both hooks, pass an ERNIE-aware preview decoder.
    preview_decoder = None
    pipe_vae = getattr(pipe, "vae", None)
    if hasattr(pipe, "_unpatchify_latents") and pipe_vae is not None and hasattr(pipe_vae, "bn"):
        def preview_decoder(p, latents):  # noqa: E306 — local closure on purpose
            vae = p.vae
            mean = vae.bn.running_mean.view(1, -1, 1, 1).to(device=latents.device, dtype=latents.dtype)
            std = torch.sqrt(vae.bn.running_var.view(1, -1, 1, 1) + 1e-5).to(device=latents.device, dtype=latents.dtype)
            unpacked = p._unpatchify_latents(latents * std + mean)
            return vae.decode(unpacked, return_dict=False)[0]

    callback = make_stepwise_callback(
        args.stepwise_image_output_dir,
        pipe,
        int(args.height),
        int(args.width),
        preview_decoder=preview_decoder,
    )

    accepted = set(inspect.signature(pipe.__call__).parameters.keys())
    pipe_kwargs = dict(
        prompt=args.prompt,
        height=int(args.height),
        width=int(args.width),
        num_inference_steps=int(args.steps),
        guidance_scale=float(args.guidance),
        generator=generator,
    )
    if args.negative_prompt and "negative_prompt" in accepted:
        pipe_kwargs["negative_prompt"] = args.negative_prompt
    if callback is not None and "callback_on_step_end" in accepted:
        pipe_kwargs["callback_on_step_end"] = callback
        if "callback_on_step_end_tensor_inputs" in accepted:
            pipe_kwargs["callback_on_step_end_tensor_inputs"] = ["latents"]
    if init_image is not None and "image" in accepted:
        pipe_kwargs["image"] = init_image
        # Disable VAE tiling for i2i — tiled encode of a small image
        # produces seams on the output (matches flux2 reference).
        vae = getattr(pipe, "vae", None)
        if vae is not None and hasattr(vae, "disable_tiling"):
            vae.disable_tiling()
        if args.image_strength is not None and "strength" in accepted:
            pipe_kwargs["strength"] = float(args.image_strength)
    # ERNIE-Image's prompt enhancer — only pass when the loaded pipeline
    # exposes the kwarg (signature filter keeps Z-Image and other models
    # unaffected).
    if args.use_pe and "use_pe" in accepted:
        pipe_kwargs["use_pe"] = True

    print("STAGE:inference", file=sys.stderr, flush=True)
    print(
        f"🎨 z-image generate seed={seed} {args.width}x{args.height} steps={args.steps} "
        f"guidance={args.guidance} device={device}",
        file=sys.stderr,
    )

    with torch.inference_mode():
        result = pipe(**pipe_kwargs)
    image = result.images[0]
    image.save(args.output)

    if callback is not None and hasattr(callback, "_stats"):
        s = callback._stats
        print(f"🖼️  stepwise summary: callback fired {s['count']} times, saved {s['saved']} previews", file=sys.stderr)

    if args.metadata:
        write_sidecar(
            args.output,
            {
                "id": Path(args.output).stem,
                "prompt": args.prompt,
                "negativePrompt": args.negative_prompt,
                "modelId": args.model,
                "seed": seed,
                "width": int(args.width),
                "height": int(args.height),
                "steps": int(args.steps),
                "guidance": float(args.guidance),
                "filename": Path(args.output).name,
                "initImageFilename": Path(args.image_path).name if args.image_path else None,
                "initImageStrength": float(args.image_strength) if args.image_strength is not None else None,
            },
        )

    if torch.backends.mps.is_available():
        torch.mps.empty_cache()
        torch.mps.synchronize()
    elif torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.synchronize()

    print(f"✅ z-image saved {args.output} (seed={seed})", file=sys.stderr)


if __name__ == "__main__":
    main()
