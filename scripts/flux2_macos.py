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


def pick_device(requested: str) -> str:
    if requested == "auto":
        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"
    if requested == "mps" and not torch.backends.mps.is_available():
        print("⚠️ MPS requested but unavailable — falling back to CPU", file=sys.stderr)
        return "cpu"
    if requested == "cuda" and not torch.cuda.is_available():
        print("⚠️ CUDA requested but unavailable — falling back to CPU", file=sys.stderr)
        return "cpu"
    return requested


def make_generator(device: str, seed: int) -> torch.Generator:
    if device in ("cuda", "mps"):
        return torch.Generator(device).manual_seed(int(seed))
    return torch.Generator().manual_seed(int(seed))


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

    print(f"🔧 sdnq: tokenizer ← {tokenizer_repo}", file=sys.stderr)
    tokenizer = AutoTokenizer.from_pretrained(tokenizer_repo, subfolder="tokenizer", use_fast=False)
    print(f"🔧 sdnq: pipeline ← {repo}", file=sys.stderr)
    pipe = Flux2KleinPipeline.from_pretrained(
        repo,
        tokenizer=tokenizer,
        torch_dtype=dtype,
        low_cpu_mem_usage=True,
    )
    pipe.to(device)
    return pipe


def load_pipeline_int8(repo: str, base_repo: str, device: str, dtype):
    from accelerate import init_empty_weights
    from diffusers import Flux2KleinPipeline
    from huggingface_hub import snapshot_download
    from optimum.quanto import requantize
    from safetensors.torch import load_file
    from transformers import AutoConfig, AutoTokenizer, Qwen3ForCausalLM

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from flux2_quantized import QuantizedFlux2Transformer2DModel

    print(f"🔧 int8: snapshot ← {repo}", file=sys.stderr)
    model_path = snapshot_download(repo)

    print("🔧 int8: transformer …", file=sys.stderr)
    qtransformer = QuantizedFlux2Transformer2DModel.from_pretrained(model_path)
    qtransformer.to(device=device, dtype=dtype)

    print("🔧 int8: text encoder …", file=sys.stderr)
    config = AutoConfig.from_pretrained(f"{model_path}/text_encoder", trust_remote_code=True)
    with init_empty_weights():
        text_encoder = Qwen3ForCausalLM(config)
    with open(f"{model_path}/text_encoder/quanto_qmap.json", "r") as f:
        te_qmap = json.load(f)
    te_state = load_file(f"{model_path}/text_encoder/model.safetensors")
    requantize(text_encoder, state_dict=te_state, quantization_map=te_qmap)
    text_encoder.eval()
    text_encoder.to(device, dtype=dtype)

    tokenizer = AutoTokenizer.from_pretrained(f"{model_path}/tokenizer")

    print(f"🔧 int8: VAE/scheduler ← {base_repo}", file=sys.stderr)
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


def apply_memory_optimizations(pipe) -> None:
    if hasattr(pipe, "enable_attention_slicing"):
        pipe.enable_attention_slicing()
    if hasattr(pipe, "enable_vae_slicing"):
        pipe.enable_vae_slicing()
    vae = getattr(pipe, "vae", None)
    if hasattr(pipe, "enable_vae_tiling"):
        pipe.enable_vae_tiling()
    elif vae is not None and hasattr(vae, "enable_tiling"):
        vae.enable_tiling()


def make_stepwise_callback(stepwise_dir: str, pipe):
    """Return a `callback_on_step_end` that decodes the running latent into a
    small preview PNG. local.js's `processLatestFrame` watches this dir and
    streams the freshest frame to the SSE client. Match mflux's filename
    shape (`step_<N>.png`, no zero padding) so the existing parser sorts
    by mtime and picks the latest correctly."""

    if not stepwise_dir:
        return None
    out = Path(stepwise_dir)
    out.mkdir(parents=True, exist_ok=True)
    vae = pipe.vae
    scaling = getattr(vae.config, "scaling_factor", None)
    if scaling is None:
        scaling = 1.0
    shift = getattr(vae.config, "shift_factor", None)
    if shift is None:
        shift = 0.0

    @torch.no_grad()
    def cb(pipe, step_index, _timestep, callback_kwargs):
        latents = callback_kwargs.get("latents")
        if latents is None:
            return callback_kwargs
        # Best-effort decode. Errors here must not abort generation — the
        # final image is still produced after the last step.
        try:
            decoded = vae.decode(latents / scaling + shift, return_dict=False)[0]
            decoded = (decoded.clamp(-1, 1) + 1) / 2
            arr = (decoded[0].float().cpu().permute(1, 2, 0).numpy() * 255).astype("uint8")
            img = Image.fromarray(arr)
            # Cap preview size — fs.watch + base64 encode every step is fine
            # for 256px thumbnails but wasteful at 1024px.
            img.thumbnail((512, 512), Image.LANCZOS)
            img.save(out / f"step_{step_index + 1}.png", "PNG", optimize=False)
        except Exception as err:
            print(f"⚠️ stepwise preview failed at step {step_index}: {err}", file=sys.stderr)
        return callback_kwargs

    return cb


def write_sidecar(output: str, payload: dict) -> None:
    sidecar = Path(output).with_suffix(".metadata.json")
    sidecar.write_text(json.dumps(payload, indent=2))


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
    return p.parse_args()


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

    seed = args.seed if args.seed is not None else int(torch.randint(0, 2**31 - 1, (1,)).item())
    generator = make_generator(device, seed)

    init_image = None
    if args.image_path:
        init_image = Image.open(args.image_path).convert("RGB").resize(
            (int(args.width), int(args.height)), Image.LANCZOS
        )

    callback = make_stepwise_callback(args.stepwise_image_output_dir, pipe)
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

    print(
        f"🎨 flux2 generate seed={seed} {args.width}x{args.height} steps={args.steps} "
        f"guidance={args.guidance} device={device}",
        file=sys.stderr,
    )

    with torch.inference_mode():
        result = pipe(**pipe_kwargs)
    image = result.images[0]
    image.save(args.output)

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
