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
    suppress_cosmetic_clip_truncation,
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


def _resolve_pipeline_cls(use_kv: bool):
    """Pick the diffusers pipeline class. `Flux2KleinKVPipeline` uses K/V-cached
    reference-token attention for multi-reference editing; both classes share
    the same component init signature (scheduler/vae/text_encoder/tokenizer/
    transformer/is_distilled), so any flux2-klein repo loads into either.

    Imports are lazy + branch-specific so a venv whose diffusers pin predates
    the KV pipeline (i.e. before `Flux2KleinKVPipeline` was added upstream)
    still serves single-image renders. The KV branch fails loudly with a clear
    upgrade hint instead of an opaque ImportError mid-load."""
    if use_kv:
        try:
            from diffusers import Flux2KleinKVPipeline
        except ImportError:
            print(
                "❌ Multi-reference editing requires diffusers with "
                "Flux2KleinKVPipeline. Re-run "
                "`INSTALL_FLUX2=1 FLUX2_FORCE_REINSTALL=1 bash scripts/setup-image-video.sh` "
                "to pick up the latest diffusers HEAD.",
                file=sys.stderr,
            )
            sys.exit(65)
        return Flux2KleinKVPipeline
    from diffusers import Flux2KleinPipeline

    return Flux2KleinPipeline


def load_pipeline_bf16(repo: str, device: str, dtype, pipeline_cls):
    """Native bf16 load — no SDNQ, no Int8. Pipeline + tokenizer come from
    the gated base repo (e.g. black-forest-labs/FLUX.2-klein-9B). Practical
    only with ~64+ GB unified memory for the 9B variant."""
    print(f"STAGE:download-pipeline:{repo}", file=sys.stderr, flush=True)
    print(f"🔧 bf16: pipeline ({pipeline_cls.__name__}) ← {repo}", file=sys.stderr)
    with heartbeat("loading-pipeline"):
        pipe = pipeline_cls.from_pretrained(
            repo,
            torch_dtype=dtype,
            low_cpu_mem_usage=True,
        )
    print("STAGE:move-to-device", file=sys.stderr, flush=True)
    with heartbeat("move-to-device"):
        pipe.to(device)
    return pipe


def load_pipeline_sdnq(repo: str, tokenizer_repo: str, device: str, dtype, pipeline_cls):
    # `sdnq` registers a custom config type at import-time. The pipeline
    # `from_pretrained` call below pulls a config that references it, so the
    # import has to happen first. Keep it inside the function so the runner
    # also works for the int8 branch on systems without sdnq installed.
    import sdnq  # noqa: F401  (registration side-effect)
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
    print(f"🔧 sdnq: pipeline ({pipeline_cls.__name__}) ← {repo}", file=sys.stderr)
    with heartbeat("loading-pipeline"):
        pipe = pipeline_cls.from_pretrained(
            repo,
            tokenizer=tokenizer,
            torch_dtype=dtype,
            low_cpu_mem_usage=True,
        )
    print("STAGE:move-to-device", file=sys.stderr, flush=True)
    with heartbeat("move-to-device"):
        pipe.to(device)
    return pipe


def load_pipeline_int8(repo: str, base_repo: str, device: str, dtype, pipeline_cls):
    from accelerate import init_empty_weights
    from huggingface_hub import snapshot_download
    from optimum.quanto import requantize
    from safetensors.torch import load_file
    from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from flux2_quantized import QuantizedFlux2Transformer2DModel

    print(f"STAGE:download-int8-snapshot:{repo}", file=sys.stderr, flush=True)
    print(f"🔧 int8: snapshot ({pipeline_cls.__name__}) ← {repo}", file=sys.stderr)
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
        pipe = pipeline_cls.from_pretrained(
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
    p.add_argument("--quantization", required=True, choices=["sdnq", "int8", "none"])
    p.add_argument("--repo", required=True, help="HF repo for the quantized weights")
    p.add_argument("--tokenizer-repo", default=None, help="HF repo for tokenizer (sdnq variants)")
    p.add_argument("--base-pipeline-repo", default=None, help="HF repo for VAE/scheduler (int8 variant)")
    # Reference-editing repo for the bf16 (`quantization=none`) path. The base
    # FLUX.2-klein-9B transformer wasn't tuned for the K/V reference-editing
    # task, so when reference images are present we load the `-kv` sibling repo
    # instead. Absent (or no reference images) → the plain bf16 path stays on
    # `--repo`. See server/lib/mediaModels.js `kvRepo`.
    p.add_argument("--kv-repo", default=None, help="HF repo to load for multi-reference editing on the bf16 path (FLUX.2-klein-9B-kv)")
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
    # Multi-reference editing. When at least one reference image is provided,
    # the runner loads `Flux2KleinKVPipeline` instead of `Flux2KleinPipeline`
    # and forwards the list of PIL refs as the pipeline's `image=` kwarg.
    # `--reference-strengths` is honored per-reference via a runtime patch on
    # Flux2KVLayerCache.store + the extract-mode causal-attention helper — see
    # `_install_per_ref_strength_patch` below. Up to 4 references (route-side cap).
    p.add_argument("--reference-images", nargs="*", default=[], help="absolute paths to reference images (multi-reference KV editing)")
    p.add_argument("--reference-strengths", nargs="*", default=[], help="0..1 strength per reference image, parallel to --reference-images (1.0 = full influence, 0.0 = ignore)")
    return p.parse_args()


# Per-call config consumed by the monkey-patched KV-cache + attention helper.
# Populated immediately before `pipe(...)` and cleared in `finally` so that a
# subsequent generation without reference strengths runs unscaled. The patch
# itself is installed once per process (idempotent).
_PORTOS_KV_REF_STRENGTHS: list[float] = []


def _install_per_ref_strength_patch() -> None:
    """Monkey-patch diffusers' Flux2 KV path to honor per-reference strengths.

    The upstream `Flux2KleinKVPipeline` concatenates all reference latents into
    a single token sequence and caches their attention K/V on step 0; subsequent
    steps reuse the cached tensors. Upstream does not expose per-reference
    weighting, so this patch scales each reference's V slice by its strength —
    in both (a) the step-0 extract-mode attention (`_flux2_kv_causal_attention`,
    txt/img → ref path) and (b) the cache that feeds steps 1+
    (`Flux2KVLayerCache.store`). K is left unscaled so softmax still allocates
    attention budget across all reference tokens; only the per-token V
    contribution is attenuated. This matches the IP-Adapter-style "ref scale"
    convention: 1.0 reproduces upstream behavior, 0.0 zeros that reference's
    contribution.
    """
    from diffusers.models.transformers import transformer_flux2 as _t2

    if getattr(_t2.Flux2KVLayerCache, "_portos_per_ref_patched", False):
        return

    # One-shot warning gate — divisibility mismatch is a misuse signal
    # (the route always sends a parallel array; only a curl caller would
    # land here), so log once instead of spamming per-layer per-step.
    _warned = {"divisibility": False}

    def _scale_v_inplace(v_tensor, num_ref_tokens: int, offset: int):
        """Scale `v_tensor[:, offset:offset+num_ref_tokens]` in-place per ref.

        Caller is responsible for owning the tensor (either fresh via `.clone()`
        or an already-cloned view from upstream). All-1.0 strengths short-
        circuit before touching the tensor.
        """
        strengths = _PORTOS_KV_REF_STRENGTHS
        num_refs = len(strengths)
        if num_ref_tokens % num_refs != 0:
            if not _warned["divisibility"]:
                print(
                    f"⚠️ --reference-strengths count ({num_refs}) doesn't divide "
                    f"ref-token count ({num_ref_tokens}); applying full influence.",
                    file=sys.stderr,
                )
                _warned["divisibility"] = True
            return
        if all(float(s) == 1.0 for s in strengths):
            return
        tokens_per_ref = num_ref_tokens // num_refs
        for i, s in enumerate(strengths):
            sf = float(s)
            if sf == 1.0:
                continue
            start = offset + i * tokens_per_ref
            end = start + tokens_per_ref
            v_tensor[:, start:end].mul_(sf)

    # Cache patch — upstream already passes a fresh clone (see
    # `Flux2KVAttnProcessor` / `Flux2KVParallelSelfAttnProcessor`), so we
    # mutate it directly instead of cloning a second time per layer.
    _original_store = _t2.Flux2KVLayerCache.store

    def _store_scaled(self, k_ref, v_ref):
        if _PORTOS_KV_REF_STRENGTHS and v_ref.shape[1] > 0:
            _scale_v_inplace(v_ref, v_ref.shape[1], offset=0)
        _original_store(self, k_ref, v_ref)

    _t2.Flux2KVLayerCache.store = _store_scaled

    # Attention patch — extract mode only (cached mode reuses the already-
    # scaled cache). `value` here is the live combined sequence used by
    # other tokens' attention downstream, so clone before mutating.
    _original_attn = _t2._flux2_kv_causal_attention

    def _attn_scaled(query, key, value, num_txt_tokens, num_ref_tokens, kv_cache=None, backend=None):
        if num_ref_tokens > 0 and kv_cache is None and _PORTOS_KV_REF_STRENGTHS:
            value = value.clone()
            _scale_v_inplace(value, num_ref_tokens, offset=num_txt_tokens)
        return _original_attn(query, key, value, num_txt_tokens, num_ref_tokens, kv_cache=kv_cache, backend=backend)

    _t2._flux2_kv_causal_attention = _attn_scaled
    _t2.Flux2KVLayerCache._portos_per_ref_patched = True


@install_hf_error_handler
def main() -> None:
    args = parse_args()

    device = pick_device(args.device)
    dtype = torch.bfloat16 if device in ("mps", "cuda") else torch.float32

    use_kv = bool(args.reference_images)
    # Multi-reference editing is gated to SDNQ + bf16 today. The int8 path
    # attaches a quanto-rehydrated transformer directly and the KV pipeline's
    # reference-token attention hooks don't compose through that wrapper, so it
    # still refuses early with a clear message rather than mislead. Lift the
    # int8 gate once its KV pipeline is validated.
    if use_kv and args.quantization == "int8":
        print(
            "❌ Multi-reference editing (--reference-images) is not supported on "
            "int8 quantization yet. Use an SDNQ variant (flux2-klein-9b / "
            "flux2-klein-4b) or the bf16 variant (flux2-klein-9b-bf16) for "
            "multi-reference renders.",
            file=sys.stderr,
        )
        sys.exit(64)
    # bf16 reference editing loads the `-kv` sibling repo (whose transformer is
    # tuned for the reference-editing task) instead of the base 9B repo. The
    # route always threads `--kv-repo` for this model, but guard the manual /
    # curl path so we don't silently run off-task on the base transformer.
    if use_kv and args.quantization == "none" and not args.kv_repo:
        print(
            "❌ Multi-reference editing on bf16 requires --kv-repo "
            "(the FLUX.2-klein-9B-kv sibling repo); the base 9B transformer "
            "is not tuned for reference editing.",
            file=sys.stderr,
        )
        sys.exit(64)
    pipeline_cls = _resolve_pipeline_cls(use_kv)
    if use_kv:
        if args.image_path:
            print(
                "⚠️ --image-path supplied alongside --reference-images; the KV pipeline "
                "doesn't support i2i strength, so the init image will be ignored.",
                file=sys.stderr,
            )

    if args.quantization == "sdnq":
        if not args.tokenizer_repo:
            print("❌ --tokenizer-repo is required for sdnq variants", file=sys.stderr)
            sys.exit(64)
        probe_hf_auth(args.tokenizer_repo)
        pipe = load_pipeline_sdnq(args.repo, args.tokenizer_repo, device, dtype, pipeline_cls)
    elif args.quantization == "int8":
        if not args.base_pipeline_repo:
            print("❌ --base-pipeline-repo is required for int8 variants", file=sys.stderr)
            sys.exit(64)
        probe_hf_auth(args.base_pipeline_repo)
        pipe = load_pipeline_int8(args.repo, args.base_pipeline_repo, device, dtype, pipeline_cls)
    elif args.quantization == "none":
        # Native bf16 — `repo` is the gated base repo itself. For multi-reference
        # editing, load the `-kv` sibling repo instead (its transformer is tuned
        # for the K/V reference-editing task); the plain text/i2i path stays on
        # the base repo. Both share the same FLUX.2-klein license.
        bf16_repo = args.kv_repo if (use_kv and args.kv_repo) else args.repo
        probe_hf_auth(bf16_repo)
        pipe = load_pipeline_bf16(bf16_repo, device, dtype, pipeline_cls)
    else:
        print(f"❌ unknown quantization: {args.quantization}", file=sys.stderr)
        sys.exit(64)
    suppress_cosmetic_clip_truncation()

    apply_memory_optimizations(pipe)
    apply_loras(pipe, args.lora_paths or [], args.lora_scales or [])

    seed = args.seed if args.seed is not None else int(torch.randint(0, 2**31 - 1, (1,)).item())
    generator = make_generator(device, seed)

    # `formats=` pins PIL's decoder dispatch to the route layer's allowed-mime
    # set — defense in depth against a Ghostscript-pipeline invocation via a
    # spoofed EPS/PDF magic in a file the upload filter validated only by
    # browser-supplied mimetype. The route already enforces .png/.jpg/.webp
    # extensions and copies bytes through, so a malformed file just fails the
    # decode cleanly here instead of routing into another format handler.
    PIL_FORMATS_ALLOWED = ["PNG", "JPEG", "WEBP"]

    init_image = None
    if args.image_path and not use_kv:
        init_image = Image.open(args.image_path, formats=PIL_FORMATS_ALLOWED).convert("RGB").resize(
            (int(args.width), int(args.height)), Image.LANCZOS
        )

    # Multi-reference editing — load each reference at the output resolution.
    # The KV pipeline encodes refs through the VAE then caches their attention
    # K/V on step 0; mismatched aspect ratios get LANCZOS-resized so the
    # transformer sees a uniform patch grid across all references.
    reference_pils = None
    if use_kv:
        reference_pils = [
            Image.open(p, formats=PIL_FORMATS_ALLOWED).convert("RGB").resize(
                (int(args.width), int(args.height)), Image.LANCZOS
            )
            for p in args.reference_images
        ]
        print(
            f"🔗 multi-reference KV: {len(reference_pils)} reference image(s) at "
            f"{int(args.width)}x{int(args.height)}",
            file=sys.stderr,
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
    if reference_pils is not None and "image" in accepted:
        # Flux2KleinKVPipeline accepts `image` as a single PIL or List[PIL].
        # Pass the list verbatim so it routes through the multi-reference
        # K/V-cache code path. The signature filter above guarantees the kwarg
        # is supported by the live pipeline.
        pipe_kwargs["image"] = reference_pils
        vae = getattr(pipe, "vae", None)
        if vae is not None and hasattr(vae, "disable_tiling"):
            vae.disable_tiling()
    elif init_image is not None and "image" in accepted:
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

    # Activate per-reference V-scaling for the duration of this pipe call.
    # Padded to len(reference_pils) with 1.0 (the route always sends a full
    # parallel array, but a curl/test caller might omit trailing slots).
    honored_strengths: list[float] = []
    if use_kv and reference_pils:
        _install_per_ref_strength_patch()
        honored_strengths = [float(s) for s in (args.reference_strengths or [])][: len(reference_pils)]
        while len(honored_strengths) < len(reference_pils):
            honored_strengths.append(1.0)
        if any(s != 1.0 for s in honored_strengths):
            entries = ", ".join(f"ref{i + 1}={s:.2f}" for i, s in enumerate(honored_strengths))
            print(f"🎚️ per-ref strengths honored: {entries}", file=sys.stderr)
        _PORTOS_KV_REF_STRENGTHS[:] = honored_strengths

    try:
        with torch.inference_mode():
            result = pipe(**pipe_kwargs)
    finally:
        _PORTOS_KV_REF_STRENGTHS.clear()
    image = result.images[0]
    image.save(args.output)

    if callback is not None and hasattr(callback, "_stats"):
        s = callback._stats
        print(f"🖼️  stepwise summary: callback fired {s['count']} times, saved {s['saved']} previews", file=sys.stderr)

    if args.metadata:
        sidecar = {
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
            "initImageFilename": Path(args.image_path).name if (args.image_path and not use_kv) else None,
            "initImageStrength": float(args.image_strength) if (args.image_strength is not None and not use_kv) else None,
        }
        if use_kv:
            sidecar["pipelineClass"] = pipeline_cls.__name__
            sidecar["referenceImageFilenames"] = [Path(p).name for p in args.reference_images]
            # Honored end-to-end: the runtime patch on Flux2KVLayerCache.store +
            # _flux2_kv_causal_attention scales each reference's V slice by the
            # corresponding strength (1.0 = upstream baseline, 0.0 = ignored).
            sidecar["referenceStrengths"] = honored_strengths
        write_sidecar(args.output, sidecar)

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
