#!/usr/bin/env python3
"""
PortOS HunyuanVideo MLX helper.

Calls hyvideo.inference.HunyuanVideoSampler from the cloned upstream repo
directly — we no longer subprocess into upstream's sample_video_mps.py
because that wrapper hardcodes infer_steps=40, guidance_scale=7.0, and forces
fp32, which silently overrides whatever the user picked in the PortOS UI.
Owning the predict() kwargs here gives the UI actual control.

Spawned by server/services/videoGen/local.js when model.runtime === 'hunyuan'.

The cloned repo at --repo-dir provides the `hyvideo` package; the model weights
come from a huggingface_hub snapshot of the user-supplied --model-repo
(typically `tencent/HunyuanVideo`).
"""

import argparse
import gc
import os
import shutil
import sys
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import emit_runtime_fingerprint, heartbeat, install_hf_error_handler  # noqa: E402


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="PortOS HunyuanVideo MLX helper")
    p.add_argument("--repo-dir", required=True, help="Cloned HunyuanVideo_MLX repo root")
    p.add_argument("--model-repo", required=True, help="HF repo of HunyuanVideo weights (e.g. tencent/HunyuanVideo)")
    p.add_argument("--prompt", required=True)
    p.add_argument("--negative-prompt", default="")
    p.add_argument("--width", type=int, required=True)
    p.add_argument("--height", type=int, required=True)
    p.add_argument("--num-frames", type=int, default=129)
    p.add_argument("--steps", type=int, default=30)
    p.add_argument("--guidance", type=float, default=6.0, help="embedded_guidance_scale for the cfg-distilled model")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--precision", default="fp32", choices=["fp16", "bf16", "fp32"],
                   help="dtype for DiT + VAE + text encoder. fp32 is the ONLY working "
                        "value on Apple Silicon MPS — verified empirically that both fp16 "
                        "and bf16 trip `MPSNDArrayMatrixMultiplication.mm:5799 failed "
                        "assertion: Destination NDArray and Accumulator NDArray cannot "
                        "have different datatype` within ~2s of the first forward pass. "
                        "MPS matmul kernels always use an fp32 accumulator internally, so "
                        "a non-fp32 output dtype guarantees a mismatch. Upstream's "
                        "sample_video_mps.py reaches the same conclusion. The choices list "
                        "keeps fp16/bf16 selectable in case a future PyTorch/MPS release "
                        "fixes this, but DO NOT switch the default without re-testing.")
    p.add_argument("--output", required=True)
    return p.parse_args()


def install_tqdm_step_emitter(stage: str) -> None:
    """Monkey-patch tqdm so each `.update()` also prints a STAGE: line that
    local.js's handleLine() parses into an SSE progress event.

    HunyuanVideo's diffusion loop drives a tqdm progress bar via
    `pipeline.progress_bar(total=num_inference_steps)`. Out of the box,
    tqdm against a pipe (no TTY) emits very sparse output — and even those
    writes are buffered enough that the UI sees nothing for the entire
    ~30-90 min run. We patch the base class so every step also pushes
    `STAGE:inference:step:<cur>:<total>:diffusion step N/M` to stderr;
    PYTHONUNBUFFERED=1 (set on the spawn env) guarantees it flushes.

    `tqdm.tqdm` and `tqdm.auto.tqdm` are separate references — diffusers'
    `progress_bar` uses `tqdm.auto`, but other libs reach for `tqdm.tqdm`
    directly. Patch both for safety.
    """
    import tqdm
    import tqdm.auto
    orig_cls = tqdm.tqdm

    class StageEmittingTqdm(orig_cls):
        def update(self, n=1):
            ret = super().update(n)
            try:
                cur = int(self.n)
                total = int(self.total) if self.total else 0
            except Exception:
                return ret
            print(
                f"STAGE:{stage}:step:{cur}:{total}:diffusion step {cur}/{total}",
                file=sys.stderr,
                flush=True,
            )
            return ret

    tqdm.tqdm = StageEmittingTqdm
    tqdm.auto.tqdm = StageEmittingTqdm


def ensure_transformers_compat_shims():
    """Make hyvideo's transformers-4.x assumptions still work on transformers 5.x.
    Idempotent.

    hyvideo was written when `CLIPTextModel` exposed its inner stack through a
    `.text_model` attribute. transformers ≥5 flattened that. The mismatch
    trips `hyvideo/text_encoder/__init__.py:34`:
        `text_encoder.final_layer_norm = text_encoder.text_model.final_layer_norm`
    Adding a self-reference makes that reassignment a no-op (the right-hand
    side already exists at the top level in 5.x).

    Companion bandaid: stage_hunyuan_model_base() walks both
    `model.model.language_model` and `model.language_model` for the same
    transformers-5.x flattening on the Llava side.
    """
    import transformers
    if not hasattr(transformers.CLIPTextModel, "text_model"):
        transformers.CLIPTextModel.text_model = property(lambda self: self)


# Repos Hunyuan needs alongside the main tencent/HunyuanVideo snapshot.
# tencent/HunyuanVideo ships only the DiT + VAE; the two text encoders
# (Llama-3 backbone from Llava, plus CLIP) live in separate public repos
# and have to be staged into the MODEL_BASE tree at the paths hyvideo's
# constants.py expects (<base>/text_encoder, <base>/text_encoder_2).
LLAVA_REPO = "xtuner/llava-llama-3-8b-v1_1-transformers"
CLIP_REPO = "openai/clip-vit-large-patch14"
# CLIP files used by hyvideo's text encoder loader — explicit allowlist
# keeps the snapshot tight (CLIP ships training artifacts we don't need).
CLIP_FILES = (
    "config.json",
    "model.safetensors",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "merges.txt",
    "special_tokens_map.json",
)


def stage_hunyuan_model_base(repo_dir, snapshot_dir):
    """Build a writable MODEL_BASE tree with everything hyvideo needs.

    Layout under `<repo_dir>/portos-models/`:
      - hunyuan-video-t2v-720p/  — symlink to <snapshot>/hunyuan-video-t2v-720p
                                   (gives the DiT + VAE without duplicating GB)
      - text_encoder/            — Llama backbone extracted from Llava-Llama-3
      - text_encoder_2/          — CLIP ViT-L/14

    Idempotent: skips downloads + preprocessing when the destination already
    looks populated. First-run extra cost is ~17 GB of downloads + a CPU
    preprocess pass that takes a couple of minutes.
    """
    base = Path(repo_dir) / "portos-models"
    base.mkdir(parents=True, exist_ok=True)

    src_main = Path(snapshot_dir) / "hunyuan-video-t2v-720p"
    dst_main = base / "hunyuan-video-t2v-720p"
    # Path.exists() follows symlinks, so a dangling link (snapshot pruned
    # from HF cache between runs) would return False AND then symlink_to
    # would raise FileExistsError because the link itself is present. Use
    # is_symlink to detect that case and recreate. lexists doesn't help
    # because we'd still need to unlink before symlink_to.
    if dst_main.is_symlink() and not dst_main.exists():
        dst_main.unlink()
    if not dst_main.exists():
        dst_main.symlink_to(src_main, target_is_directory=True)

    from huggingface_hub import snapshot_download as _snap

    te2 = base / "text_encoder_2"
    if not (te2 / "config.json").is_file():
        # Stage into `.partial` and atomic-rename so an interrupted snapshot
        # (Ctrl-C, network drop) can't satisfy the `config.json`-only
        # idempotency gate above with a half-downloaded directory — without
        # this, the next run would skip the download and fail deep inside
        # hyvideo with a confusing missing-weights error. Mirrors the
        # text_encoder branch below.
        te2_staging = te2.with_name(te2.name + ".partial")
        shutil.rmtree(te2_staging, ignore_errors=True)
        te2_staging.mkdir(parents=True)
        print(f"STAGE:download-clip:{CLIP_REPO}", file=sys.stderr, flush=True)
        with heartbeat("download-clip"):
            _snap(CLIP_REPO, local_dir=str(te2_staging), allow_patterns=list(CLIP_FILES))
        shutil.rmtree(te2, ignore_errors=True)
        os.replace(te2_staging, te2)

    te = base / "text_encoder"
    if not (te / "config.json").is_file():
        # Llava ships ~16 GB of weights; we only need the language_model
        # half (the Llama backbone) plus the tokenizer. Download into a
        # scratch dir, run upstream's split, then delete the raw download.
        scratch = base / "_llava_raw"
        print(f"STAGE:download-llava:{LLAVA_REPO}", file=sys.stderr, flush=True)
        with heartbeat("download-llava"):
            _snap(LLAVA_REPO, local_dir=str(scratch))

        print("STAGE:preprocess-text-encoder", file=sys.stderr, flush=True)
        # transformers + torch are heavy imports — defer until we know we
        # need them (subsequent renders skip this whole branch).
        from transformers import AutoProcessor, LlavaForConditionalGeneration
        import torch
        with heartbeat("preprocess-llava"):
            processor = AutoProcessor.from_pretrained(str(scratch))
            # fp16 halves the peak RAM during preprocessing (Llava is ~16 GB
            # at fp32, ~8 GB at fp16). hyvideo loads text_encoder at fp16
            # downstream anyway, so we save nothing by extracting at fp32.
            model = LlavaForConditionalGeneration.from_pretrained(
                str(scratch),
                torch_dtype=torch.float16,
                low_cpu_mem_usage=True,
                device_map=None,
            )
            # transformers ≥5 wraps the Llama backbone in an outer LlavaModel
            # (model.model.language_model); 4.x had it flat (model.language_model).
            # Walk one level deep first, fall back to flat, raise on neither.
            language_model = getattr(getattr(model, "model", model), "language_model", None)
            if language_model is None:
                raise AttributeError(
                    f"Could not locate Llava's language_model on {type(model).__name__}; "
                    "transformers structure changed again."
                )
            # Atomic write via `.partial` rename — a crash mid save_pretrained
            # would otherwise leave a half-written text_encoder/ that the
            # config.json idempotency check above would treat as complete.
            staging = te.with_name(te.name + ".partial")
            shutil.rmtree(staging, ignore_errors=True)
            staging.mkdir(parents=True)
            language_model.save_pretrained(str(staging), safe_serialization=True)
            processor.tokenizer.save_pretrained(str(staging))
            del model, processor, language_model
            gc.collect()
            os.replace(staging, te)

        def _warn_on_rmtree_error(func, path, exc_info):
            print(f"⚠️  hunyuan: failed to clean scratch {path}: {exc_info[1]}", file=sys.stderr)
        shutil.rmtree(scratch, onerror=_warn_on_rmtree_error)

    return base


@install_hf_error_handler
def main() -> int:
    cli = parse_args()

    # Runtime fingerprint at startup — recorded by PortOS so garbled output can
    # be tied to a specific torch/diffusers/mlx stack on this chip.
    emit_runtime_fingerprint("hunyuan", ["torch", "diffusers", "transformers", "mlx"])

    repo_dir = Path(cli.repo_dir).expanduser().resolve()
    if not repo_dir.is_dir():
        print(f"❌ HunyuanVideo MLX repo not found at {repo_dir}", file=sys.stderr)
        return 64

    # hyvideo isn't pip-installed — it's a package directory inside the repo.
    # Prepend the repo so `import hyvideo.*` resolves without a chdir.
    sys.path.insert(0, str(repo_dir))

    # MPS probe BEFORE the multi-GB snapshot — no point pulling 30 GB if the
    # render can't run. torch import is ~5s, snapshot is gigabytes.
    import torch
    if not torch.backends.mps.is_available():
        print("❌ MPS not available — HunyuanVideo MLX requires Apple Silicon", file=sys.stderr)
        return 64

    print(f"STAGE:download-weights:{cli.model_repo}", file=sys.stderr, flush=True)
    try:
        from huggingface_hub import snapshot_download
    except Exception as err:
        print(f"❌ huggingface_hub import failed: {err}", file=sys.stderr)
        return 64
    # snapshot_download can stall for minutes on a single multi-GB shard;
    # heartbeat keeps the PortOS idle watchdog from killing us mid-pull.
    with heartbeat("download-weights"):
        ckpt_dir = snapshot_download(cli.model_repo)
    print(f"🔧 hunyuan: weights ← {ckpt_dir}", file=sys.stderr)

    # tencent/HunyuanVideo ships only the DiT + VAE — the text encoders are
    # separate public repos that have to be staged into a MODEL_BASE tree
    # at the paths hyvideo.constants expects. First run downloads ~17 GB
    # extra; subsequent renders are no-op.
    model_base = stage_hunyuan_model_base(repo_dir, ckpt_dir)
    print(f"🔧 hunyuan: model base ← {model_base}", file=sys.stderr)

    # hyvideo.constants reads MODEL_BASE at import time to build VAE_PATH and
    # TEXT_ENCODER_PATH. Set before importing hyvideo or the lookup hits the
    # default "./ckpts" (relative to cwd) and fails to find the encoders.
    os.environ["MODEL_BASE"] = str(model_base)

    print("STAGE:load-pipeline", file=sys.stderr, flush=True)
    # Install BEFORE importing hyvideo / diffusers — they capture references
    # to `tqdm.tqdm` at import time, so a later patch won't reach the bar
    # that pipeline_hunyuan_video.py actually uses for the diffusion loop.
    install_tqdm_step_emitter("inference")
    ensure_transformers_compat_shims()
    from hyvideo.config import parse_args as hv_parse_args
    from hyvideo.inference import HunyuanVideoSampler
    from hyvideo.utils.file_utils import save_videos_grid

    # Borrow hyvideo's full argparse namespace so every model default
    # (latent_channels, vae='884-16c-hy', flow_shift, etc.) is populated.
    # mock.patch.object scopes the sys.argv swap to the parse_args call so a
    # signal handler firing mid-block can't see our placeholder argv.
    with unittest.mock.patch.object(sys, "argv", ["generate_hunyuan"]):
        hv = hv_parse_args()

    # Override only the fields the UI controls. precision is forced equal
    # across DiT / VAE / text encoder — three precision knobs on a video gen
    # form would be excessive, and they typically need to match for MPS.
    hv.model_base = str(model_base)
    hv.dit_weight = str(model_base / "hunyuan-video-t2v-720p" / "transformers" / "mp_rank_00_model_states.pt")
    hv.video_size = [int(cli.height), int(cli.width)]
    hv.video_length = int(cli.num_frames)
    hv.infer_steps = int(cli.steps)
    hv.embedded_cfg_scale = float(cli.guidance)
    hv.seed = int(cli.seed)
    hv.prompt = cli.prompt
    hv.neg_prompt = cli.negative_prompt or None
    hv.precision = cli.precision
    hv.vae_precision = cli.precision
    hv.text_encoder_precision = cli.precision
    # hyvideo carries a separate precision knob for the second text encoder
    # (CLIP-L). Without this, CLIP-L silently loads at its default (fp16) even
    # when we ask for fp32 everywhere else — and on MPS that single mismatched
    # dtype is enough to trip the matmul accumulator assertion at the first
    # text-encoder forward pass.
    hv.text_encoder_precision_2 = cli.precision
    # Autocast on MPS produces NaNs for some Hunyuan layers; the upstream
    # wrapper disabled it too. Keep off until tested.
    hv.disable_autocast = True

    # Fail-fast: from_pretrained spends ~1-3 min loading other shards before
    # discovering the DiT file is missing. Check up front for a clear error.
    if not Path(hv.dit_weight).is_file():
        print(f"❌ expected DiT weights missing: {hv.dit_weight}", file=sys.stderr)
        return 64

    device = torch.device("mps")
    print(
        f"🎬 hunyuan generate {cli.width}x{cli.height} frames={cli.num_frames} "
        f"steps={cli.steps} guidance={cli.guidance} precision={cli.precision}",
        file=sys.stderr,
    )

    print("STAGE:from-pretrained", file=sys.stderr, flush=True)
    # from_pretrained loads ~30 GB into MPS on a cold run — silent for
    # minutes (mmap + weight assignment, no tqdm). Same idle-watchdog
    # concern as the snapshot pull.
    with heartbeat("from-pretrained"):
        sampler = HunyuanVideoSampler.from_pretrained(model_base, args=hv, device=device)

    print("STAGE:inference", file=sys.stderr, flush=True)
    outputs = sampler.predict(
        prompt=hv.prompt,
        height=hv.video_size[0],
        width=hv.video_size[1],
        video_length=hv.video_length,
        seed=hv.seed,
        negative_prompt=hv.neg_prompt,
        infer_steps=hv.infer_steps,
        # cfg_scale stays at the hyvideo default (1.0) — the cfg-distilled
        # variant uses embedded_guidance_scale as the real CFG knob.
        guidance_scale=hv.cfg_scale,
        embedded_guidance_scale=hv.embedded_cfg_scale,
        flow_shift=hv.flow_shift,
        batch_size=hv.batch_size,
        num_videos_per_prompt=hv.num_videos,
    )

    # `outputs["samples"]` may be a list, None, or — in some hyvideo paths — a
    # torch tensor. Don't use `or []`: bool(tensor) on a multi-element tensor
    # raises `RuntimeError: Boolean value of Tensor with more than one value
    # is ambiguous` before we ever reach save_videos_grid. Check explicitly.
    samples = outputs.get("samples")
    if samples is None or len(samples) == 0:
        print("❌ hunyuan predict() returned no samples", file=sys.stderr)
        return 1

    Path(cli.output).parent.mkdir(parents=True, exist_ok=True)
    # samples[0] is (C, T, H, W) — save_videos_grid wants (B, C, T, H, W),
    # so unsqueeze the batch dim before writing.
    save_videos_grid(samples[0].unsqueeze(0), cli.output, fps=24)

    if not Path(cli.output).exists():
        print(f"❌ hunyuan finished but {cli.output} missing", file=sys.stderr)
        return 1

    print(f"✅ hunyuan saved {cli.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
