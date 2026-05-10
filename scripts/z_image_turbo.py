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
import json
import os
import sys
import threading
from contextlib import contextmanager
from pathlib import Path

os.environ.setdefault("PYTORCH_MPS_FAST_MATH", "1")

import torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lora_utils import apply_loras  # noqa: E402


@contextmanager
def heartbeat(stage: str, interval: float = 20.0):
    # Diffusers' from_pretrained on a fully-cached 10-25 GB model is silent
    # for several minutes (mmap + weight assignment, no tqdm), which trips the
    # JS-side idle watchdog (default 5min). Emit a non-noise stderr line every
    # `interval` seconds so handleLine() in imageGen/local.js sees activity
    # and resets lastActivityAt. True hangs (GIL-pinned C extension, no I/O)
    # still trip the watchdog because the heartbeat thread can't print either.
    stop = threading.Event()

    def beat():
        elapsed = 0
        while not stop.wait(interval):
            elapsed += int(interval)
            print(f"STAGE:{stage}:heartbeat:{elapsed}s", file=sys.stderr, flush=True)

    t = threading.Thread(target=beat, daemon=True)
    t.start()
    try:
        yield
    finally:
        stop.set()
        t.join(timeout=interval + 1)


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


def make_stepwise_callback(stepwise_dir: str, pipe, height: int, width: int):
    """Return a `callback_on_step_end` that decodes the running latent into a
    small preview PNG. local.js's `processLatestFrame` watches this dir and
    streams the freshest frame to the SSE client.

    Z-Image latents come back in the standard `(B, C, H_lat, W_lat)` layout
    (unlike FLUX.2's packed transformer latents) so the decode path is a
    plain VAE call — no unpack helper needed.
    """
    if not stepwise_dir:
        return None
    out = Path(stepwise_dir)
    out.mkdir(parents=True, exist_ok=True)
    vae = pipe.vae
    scaling = getattr(vae.config, "scaling_factor", 1.0) or 1.0
    shift = getattr(vae.config, "shift_factor", 0.0) or 0.0
    # ERNIE keeps latents in float32 even when the pipeline was loaded with
    # torch_dtype=bfloat16, so `vae.decode(latents / scaling + shift)` feeds
    # float32 into a bfloat16 VAE and errors with "Input type (float) and
    # bias type (c10::BFloat16) should be the same". Capture the VAE's actual
    # weight dtype + device once so the callback can align the scaled latents
    # before decode.
    try:
        vae_param = next(vae.parameters())
        vae_dtype, vae_device = vae_param.dtype, vae_param.device
    except StopIteration:
        vae_dtype, vae_device = None, None

    fired = {"count": 0, "saved": 0}

    @torch.no_grad()
    def cb(pipe, step_index, _timestep, callback_kwargs):
        fired["count"] += 1
        latents = callback_kwargs.get("latents")
        if latents is None:
            if step_index == 0:
                print("⚠️ stepwise: latents missing from callback_kwargs", file=sys.stderr)
            return callback_kwargs
        if step_index == 0:
            print(f"🖼️  stepwise: callback live, latents.shape={tuple(latents.shape)}", file=sys.stderr)
        try:
            if latents.dim() != 4:
                # Some pipelines return packed latents. Skip preview rather
                # than guess the unpack shape — the final image still saves.
                return callback_kwargs
            scaled = latents / scaling + shift
            if vae_dtype is not None and (scaled.dtype != vae_dtype or scaled.device != vae_device):
                scaled = scaled.to(device=vae_device, dtype=vae_dtype)
            decoded = vae.decode(scaled, return_dict=False)[0]
            decoded = (decoded.clamp(-1, 1) + 1) / 2
            arr = (decoded[0].float().cpu().permute(1, 2, 0).numpy() * 255).astype("uint8")
            img = Image.fromarray(arr)
            img.thumbnail((512, 512), Image.LANCZOS)
            img.save(out / f"step_{step_index + 1}.png", "PNG", optimize=False)
            fired["saved"] += 1
        except Exception as err:
            print(f"⚠️ stepwise preview failed at step {step_index}: {type(err).__name__}: {err}", file=sys.stderr)
        return callback_kwargs

    cb._stats = fired
    return cb


def write_sidecar(output: str, payload: dict) -> None:
    sidecar = Path(output).with_suffix(".metadata.json")
    sidecar.write_text(json.dumps(payload, indent=2))


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

    callback = make_stepwise_callback(args.stepwise_image_output_dir, pipe, int(args.height), int(args.width))

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


def _emit_user_error(kind: str, message: str, repo: str = "") -> None:
    line = f"USER_ERROR:{kind}"
    if repo:
        line += f":{repo}"
    print(line, file=sys.stderr, flush=True)
    print(f"❌ {message}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
    except SystemExit:
        raise
    except Exception as err:
        # Friendly USER_ERROR markers for common HF failure modes so the UI
        # surfaces actionable text instead of raw "Exit code 1".
        from huggingface_hub.errors import GatedRepoError, RepositoryNotFoundError, HfHubHTTPError
        chain = []
        cur = err
        while cur is not None:
            chain.append(cur)
            cur = cur.__cause__ or cur.__context__

        def _repo_from_hf_error(hf_err):
            repo = getattr(hf_err, "repo_id", None) or ""
            if repo:
                return repo
            url = getattr(getattr(hf_err, "response", None), "url", None) or \
                  getattr(getattr(hf_err, "request", None), "url", None)
            if url is None:
                return ""
            path = str(url).split("huggingface.co", 1)[-1].lstrip("/")
            parts = path.split("/")
            if parts[:1] == ["api"] and len(parts) >= 4 and parts[1] in {"models", "datasets", "spaces"}:
                return f"{parts[2]}/{parts[3]}"
            if len(parts) >= 2 and parts[0] not in {"api", "settings", "join"}:
                return f"{parts[0]}/{parts[1]}"
            return ""

        gated = next((e for e in chain if isinstance(e, GatedRepoError)), None)
        notfound = next((e for e in chain if isinstance(e, RepositoryNotFoundError)), None)
        http = next((e for e in chain if isinstance(e, HfHubHTTPError)), None)
        if gated is not None:
            repo = _repo_from_hf_error(gated)
            url = f"https://huggingface.co/{repo}" if repo else "https://huggingface.co/"
            _emit_user_error(
                "gated_repo",
                f"Access to {repo or 'the model repo'} is restricted. Visit {url} "
                f"to request access, then make sure your HF token is set in PortOS.",
                repo,
            )
            sys.exit(2)
        status = getattr(getattr(http, "response", None), "status_code", None) if http else None
        if status == 401:
            _emit_user_error(
                "hf_unauthorized",
                "HuggingFace rejected the token (401). Check that the token is valid "
                "and has read access, then re-paste it in PortOS.",
            )
            sys.exit(2)
        if notfound is not None:
            repo = _repo_from_hf_error(notfound)
            _emit_user_error("repo_not_found", f"HF repo not found: {repo or '(unknown)'}", repo)
            sys.exit(2)
        _emit_user_error("unknown", f"{type(err).__name__}: {err}")
        raise
