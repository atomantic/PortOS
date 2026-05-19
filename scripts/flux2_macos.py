#!/usr/bin/env python3
"""
PortOS FLUX.2-klein runner.

Spawned by `server/services/imageGen/local.js` when the active model has
`runner: 'flux2'` in `data/media-models.json`. Mirrors `mflux-generate`'s
CLI surface so the dispatcher only needs to swap the binary path; all the
progress / metadata / stepwise / cancel plumbing on the JS side stays the
same.

Quantization branches:
  - `sdnq`: Disty0/FLUX.2-klein-{4B,9B}-SDNQ-4bit-dynamic*. Tokenizer is
    pulled from the gated `black-forest-labs/...` base repo because the
    SDNQ packages ship without vocab files.
  - `int8`: aydin99/FLUX.2-klein-4B-int8 — uses the QuantizedFlux2Transformer
    shim from flux2_quantized.py to rehydrate optimum-quanto weights, then
    stitches them into a Flux2KleinPipeline that draws VAE/scheduler from
    the gated base repo.

Both branches need an HF_TOKEN with the FLUX.2-klein license accepted.
"""

import argparse
import inspect
import json
import os
import sys
from pathlib import Path

# Must precede `import torch` — enables the fast-math kernel path on MPS,
# matches the upstream reference implementation.
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


def probe_hf_auth(repo: str) -> None:
    """Fail early with a clear message when HF_TOKEN is missing or the
    license hasn't been accepted. Without this probe, the user sees a vague
    HTTP 401 stack trace mid-pipeline-load."""
    from huggingface_hub import HfApi
    from huggingface_hub.utils import GatedRepoError, HfHubHTTPError, RepositoryNotFoundError
    try:
        HfApi().model_info(repo)
    except GatedRepoError:
        print(
            f"❌ HF gated repo: accept license at https://huggingface.co/{repo} "
            f"and set HF_TOKEN before generating.",
            file=sys.stderr,
        )
        sys.exit(2)
    except RepositoryNotFoundError:
        print(f"❌ HF repo not found: {repo}", file=sys.stderr)
        sys.exit(2)
    except HfHubHTTPError as err:
        if getattr(err.response, "status_code", None) == 401:
            print(
                f"❌ HF auth required for {repo}. Set HF_TOKEN (and accept the "
                f"license at https://huggingface.co/{repo}).",
                file=sys.stderr,
            )
            sys.exit(2)
        # Network blip / HF down — let the pipeline call retry.
        print(f"⚠️ HF probe non-fatal error: {err}", file=sys.stderr)


def load_pipeline_sdnq(repo: str, tokenizer_repo: str, device: str, dtype):
    # `sdnq` registers a custom config type at import-time. The Flux2KleinPipeline
    # `from_pretrained` call below pulls a config that references it, so the
    # import has to happen first. Keep it inside the function so the runner
    # also works for the int8 branch on systems without sdnq installed.
    import sdnq  # noqa: F401  (registration side-effect)
    from diffusers import Flux2KleinPipeline
    from transformers import AutoTokenizer

    # STAGE markers are parsed by server/services/imageGen/local.js#handleLine
    # and emitted as `stage` SSE events so the UI can show "Downloading model
    # weights (~8 GB on first run)" instead of a misleading "step 0/8". The
    # tokenizer is small (a few MB), the pipeline + transformer is the big
    # ~8 GB SDNQ-quantized weights download — flagged as `download-pipeline`.
    print(f"STAGE:download-tokenizer:{tokenizer_repo}", file=sys.stderr, flush=True)
    print(f"🔧 sdnq: tokenizer ← {tokenizer_repo}", file=sys.stderr)
    with heartbeat("loading-tokenizer"):
        tokenizer = AutoTokenizer.from_pretrained(tokenizer_repo, subfolder="tokenizer", use_fast=False)
    print(f"STAGE:download-pipeline:{repo}", file=sys.stderr, flush=True)
    print(f"🔧 sdnq: pipeline ← {repo}", file=sys.stderr)
    with heartbeat("loading-pipeline"):
        pipe = Flux2KleinPipeline.from_pretrained(
            repo,
            tokenizer=tokenizer,
            torch_dtype=dtype,
            low_cpu_mem_usage=True,
        )
    print("STAGE:move-to-device", file=sys.stderr, flush=True)
    with heartbeat("move-to-device"):
        pipe.to(device)
    return pipe


def load_pipeline_int8(repo: str, base_repo: str, device: str, dtype):
    from accelerate import init_empty_weights
    from diffusers import Flux2KleinPipeline
    from huggingface_hub import snapshot_download
    from optimum.quanto import requantize
    from safetensors.torch import load_file
    from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from flux2_quantized import QuantizedFlux2Transformer2DModel

    print(f"STAGE:download-int8-snapshot:{repo}", file=sys.stderr, flush=True)
    print(f"🔧 int8: snapshot ← {repo}", file=sys.stderr)
    with heartbeat("downloading-snapshot"):
        model_path = snapshot_download(repo)

    print("STAGE:load-transformer", file=sys.stderr, flush=True)
    print("🔧 int8: transformer …", file=sys.stderr)
    with heartbeat("loading-transformer"):
        qtransformer = QuantizedFlux2Transformer2DModel.from_pretrained(model_path)
        qtransformer.to(device=device, dtype=dtype)

    print("STAGE:load-text-encoder", file=sys.stderr, flush=True)
    print("🔧 int8: text encoder …", file=sys.stderr)
    # AutoModelForCausalLM picks the right class from the config
    # (Qwen3ForCausalLM here). transformers>=4.51 ships Qwen3 in-tree so we
    # don't need trust_remote_code; passing it would let a maliciously edited
    # model registry point at a repo that executes arbitrary Python at load.
    with heartbeat("loading-text-encoder"):
        config = AutoConfig.from_pretrained(f"{model_path}/text_encoder")
        with init_empty_weights():
            text_encoder = AutoModelForCausalLM.from_config(config)
        with open(f"{model_path}/text_encoder/quanto_qmap.json", "r") as f:
            te_qmap = json.load(f)
        te_state = load_file(f"{model_path}/text_encoder/model.safetensors")
        requantize(text_encoder, state_dict=te_state, quantization_map=te_qmap)
        text_encoder.eval()
        text_encoder.to(device, dtype=dtype)

        tokenizer = AutoTokenizer.from_pretrained(f"{model_path}/tokenizer")

    print(f"🔧 int8: VAE/scheduler ← {base_repo}", file=sys.stderr)
    with heartbeat("loading-vae-scheduler"):
        pipe = Flux2KleinPipeline.from_pretrained(
            base_repo,
            transformer=None,
            text_encoder=None,
            tokenizer=None,
            torch_dtype=dtype,
        )
        pipe.transformer = qtransformer._wrapped
        pipe.text_encoder = text_encoder
        pipe.tokenizer = tokenizer
        pipe.to(device)
    return pipe


def _unpack_flux2_latents(latents, height: int, width: int, vae_scale: int = 8, patch: int = 2):
    """Convert Flux2 transformer-packed latents `(B, num_patches, C*P*P)` back
    to the VAE-friendly `(B, C, H_lat, W_lat)` layout.

    For 1024×576 with vae_scale=8 patch=2: `(1, 2304, 128)` → `(1, 16, 72, 128)`
    (2304 = 36×64 patches, 128 = 16 channels × 2×2 patch). diffusers' own
    `_unpack_latents_with_ids` requires an `x_ids` tensor not exposed to the
    callback, so we do the math ourselves.
    """
    bsz, num_patches, ch_packed = latents.shape
    h = height // vae_scale // patch
    w = width // vae_scale // patch
    c = ch_packed // (patch * patch)
    if h * w != num_patches or c * patch * patch != ch_packed:
        raise ValueError(
            f"unpack mismatch: latents={tuple(latents.shape)} expected "
            f"num_patches={h*w} channels_packed={c*patch*patch} for {height}x{width}"
        )
    latents = latents.view(bsz, h, w, c, patch, patch)
    latents = latents.permute(0, 3, 1, 4, 2, 5)
    return latents.reshape(bsz, c, h * patch, w * patch)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="PortOS FLUX.2-klein runner")
    p.add_argument("--model", required=True, help="model id (e.g. flux2-klein-4b)")
    p.add_argument("--quantization", required=True, choices=["sdnq", "int8"])
    p.add_argument("--repo", required=True, help="HF repo for the quantized weights")
    p.add_argument("--tokenizer-repo", default=None, help="HF repo for tokenizer (sdnq variants)")
    p.add_argument("--base-pipeline-repo", default=None, help="HF repo for VAE/scheduler (int8 variant)")
    p.add_argument("--prompt", required=True)
    p.add_argument("--negative-prompt", default="")
    p.add_argument("--width", type=int, default=1024)
    p.add_argument("--height", type=int, default=1024)
    p.add_argument("--steps", type=int, default=8)
    p.add_argument("--guidance", type=float, default=3.5)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--output", required=True)
    p.add_argument("--metadata", action="store_true", help="write <output>.metadata.json sidecar")
    p.add_argument("--image-path", default=None, help="optional init image for i2i")
    p.add_argument("--image-strength", type=float, default=None, help="0..1 i2i denoise strength")
    p.add_argument("--stepwise-image-output-dir", default=None)
    p.add_argument("--device", default="auto", choices=["auto", "mps", "cuda", "cpu"])
    p.add_argument("--lora-paths", nargs="*", default=[], help="absolute paths to LoRA .safetensors files")
    p.add_argument("--lora-scales", nargs="*", default=[], help="scale per LoRA, parallel to --lora-paths")
    # Multi-reference editing — accepted but currently ignored. The Node side
    # already plumbs these end-to-end so the UI + server contract is shippable;
    # the diffusers multi-reference pipeline wiring lands with the
    # FLUX.2-klein-9B-kv model swap (see PLAN.md `flux2-multi-reference-python-runner`).
    # Without these stubs argparse would reject the args with "unrecognized
    # arguments" and break every single-init FLUX.2 render once the route is live.
    p.add_argument("--reference-images", nargs="*", default=[], help="(reserved) absolute paths to reference images")
    p.add_argument("--reference-strengths", nargs="*", default=[], help="(reserved) 0..1 strength per reference image, parallel to --reference-images")
    return p.parse_args()


@install_hf_error_handler
def main() -> None:
    args = parse_args()

    device = pick_device(args.device)
    dtype = torch.bfloat16 if device in ("mps", "cuda") else torch.float32

    if args.quantization == "sdnq":
        if not args.tokenizer_repo:
            print("❌ --tokenizer-repo is required for sdnq variants", file=sys.stderr)
            sys.exit(64)
        probe_hf_auth(args.tokenizer_repo)
        pipe = load_pipeline_sdnq(args.repo, args.tokenizer_repo, device, dtype)
    elif args.quantization == "int8":
        if not args.base_pipeline_repo:
            print("❌ --base-pipeline-repo is required for int8 variants", file=sys.stderr)
            sys.exit(64)
        probe_hf_auth(args.base_pipeline_repo)
        pipe = load_pipeline_int8(args.repo, args.base_pipeline_repo, device, dtype)
    else:
        print(f"❌ unknown quantization: {args.quantization}", file=sys.stderr)
        sys.exit(64)

    apply_memory_optimizations(pipe)
    apply_loras(pipe, args.lora_paths or [], args.lora_scales or [])

    seed = args.seed if args.seed is not None else int(torch.randint(0, 2**31 - 1, (1,)).item())
    generator = make_generator(device, seed)

    init_image = None
    if args.image_path:
        init_image = Image.open(args.image_path).convert("RGB").resize(
            (int(args.width), int(args.height)), Image.LANCZOS
        )

    callback = make_stepwise_callback(
        args.stepwise_image_output_dir,
        pipe,
        int(args.height),
        int(args.width),
        unpack_latents=_unpack_flux2_latents,
    )
    # Flux2KleinPipeline.__call__ doesn't always accept negative_prompt or
    # strength — passing an unsupported kwarg raises TypeError. Filter to
    # what the live signature actually accepts.
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
        # Some pipelines accept the callback but not the explicit input list;
        # only set when supported.
        if "callback_on_step_end_tensor_inputs" in accepted:
            pipe_kwargs["callback_on_step_end_tensor_inputs"] = ["latents"]
    if init_image is not None and "image" in accepted:
        pipe_kwargs["image"] = init_image
        # Disable VAE tiling for i2i — tiled encode of a small image
        # produces seams on the output (matches the reference impl).
        vae = getattr(pipe, "vae", None)
        if vae is not None and hasattr(vae, "disable_tiling"):
            vae.disable_tiling()
        if args.image_strength is not None and "strength" in accepted:
            pipe_kwargs["strength"] = float(args.image_strength)

    print("STAGE:inference", file=sys.stderr, flush=True)
    print(
        f"🎨 flux2 generate seed={seed} {args.width}x{args.height} steps={args.steps} "
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
                "quantization": args.quantization,
                "filename": Path(args.output).name,
                "initImageFilename": Path(args.image_path).name if args.image_path else None,
                "initImageStrength": float(args.image_strength) if args.image_strength is not None else None,
            },
        )

    # Free VRAM eagerly so a back-to-back generation in the same process
    # doesn't OOM. The PortOS runner respawns per request right now, so this
    # is mostly belt-and-suspenders.
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()
        torch.mps.synchronize()
    elif torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.synchronize()

    print(f"✅ flux2 saved {args.output} (seed={seed})", file=sys.stderr)


if __name__ == "__main__":
    main()
