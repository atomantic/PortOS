#!/usr/bin/env python3
"""FLUX.2 Klein LoRA trainer — vendored, MPS-aware (PortOS).

Trains a character LoRA on the bf16 Klein base (NEVER the SDNQ/int8
quantized inference repos — no useful gradients through quant layers).
The trained adapter loads onto quantized inference pipelines of the same
size variant because the transformer hidden dims match.

Two phases keep peak memory survivable on Apple Silicon:

  1. STAGE:precompute-latents — encode every dataset image to VAE latents
     and every caption to Qwen3 text embeddings ONCE, then free the text
     encoder and move the VAE off-device. Only the transformer stays
     resident for the training loop.
  2. STAGE:training — bf16 transformer + peft LoRA adapter on the attention
     projections, gradient checkpointing, AdamW, flow-matching loss
     (target = noise - latents, logit-normal timestep sampling — matches
     the FLUX family training recipes).

Line protocol (parsed by server/services/loraTraining/progress.js):
  STEP:<cur>:<total>:<loss>   CHECKPOINT:<path>:<step>   SAMPLE:<path>:<step>
  STAGE:<name>[...heartbeat]  STATUS:<msg>   USER_ERROR:<kind>:<msg>
  RESULT:{"adapter_path": ..., "steps": N, "final_loss": F}

SIGTERM → finish the current step, save a cancel checkpoint, exit 143.
"""

import argparse
import gc
import json
import os
import signal
import sys
from pathlib import Path

os.environ.setdefault("PYTORCH_MPS_FAST_MATH", "1")

import numpy as np
import torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import (  # noqa: E402
    heartbeat,
    install_hf_error_handler,
    pick_device,
)

STOP_REQUESTED = False


def _on_sigterm(_sig, _frame):
    global STOP_REQUESTED
    STOP_REQUESTED = True
    print("STATUS:cancel requested — finishing current step and checkpointing", flush=True)


signal.signal(signal.SIGTERM, _on_sigterm)


def log(msg: str) -> None:
    print(msg, flush=True)


def parse_args():
    p = argparse.ArgumentParser(description="FLUX.2 Klein LoRA trainer")
    p.add_argument("--model-repo", required=True, help="bf16 base repo (black-forest-labs/FLUX.2-klein-4B|9B)")
    p.add_argument("--manifest", required=True, help="JSON manifest: { triggerWord, images: [{ path, caption }] }")
    p.add_argument("--output-dir", required=True)
    p.add_argument("--trigger-word", required=True)
    p.add_argument("--steps", type=int, default=1000)
    p.add_argument("--rank", type=int, default=16)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--resolution", type=int, default=512)
    p.add_argument("--checkpoint-every", type=int, default=250)
    p.add_argument("--sample-every", type=int, default=250)
    p.add_argument("--sample-prompt", default=None)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--device", default="auto")
    p.add_argument("--resume-from", default=None,
                   help="checkpoint dir to resume from (restores adapter + AdamW optimizer state + step offset from optimizer.pt)")
    return p.parse_args()


def load_image_tensor(path: str, resolution: int) -> torch.Tensor:
    """Open → RGB → shortest-side resize → center crop → [-1, 1] CHW tensor."""
    img = Image.open(path).convert("RGB")
    w, h = img.size
    scale = resolution / min(w, h)
    img = img.resize((max(resolution, round(w * scale)), max(resolution, round(h * scale))), Image.LANCZOS)
    w, h = img.size
    left, top = (w - resolution) // 2, (h - resolution) // 2
    img = img.crop((left, top, left + resolution, top + resolution))
    t = torch.from_numpy(np.asarray(img)).float() / 127.5 - 1.0
    return t.permute(2, 0, 1).unsqueeze(0)  # (1, 3, H, W)


def lora_target_modules(transformer) -> list:
    """Collect attention-projection Linear module name suffixes that actually
    exist in this transformer — robust to naming drift across diffusers
    versions (to_q vs add_q_proj etc.)."""
    wanted = ("to_q", "to_k", "to_v", "to_out.0", "add_q_proj", "add_k_proj", "add_v_proj", "to_add_out")
    found = set()
    for name, module in transformer.named_modules():
        if not isinstance(module, torch.nn.Linear):
            continue
        if ".attn" not in name and "attention" not in name:
            continue
        for suffix in wanted:
            if name.endswith(suffix):
                found.add(suffix)
    if not found:
        raise RuntimeError("No attention projection Linears found to target with LoRA")
    return sorted(found)


def save_checkpoint(pipe_cls, transformer, optimizer, out_dir: Path, step: int) -> Path:
    """Persist the adapter for inference/promotion AND a self-contained resume
    bundle (`optimizer.pt`) carrying the AdamW state, the PEFT adapter state, and
    the step counter — so `--resume-from` continues mid-run (correct optimizer
    momentum + starting-step offset) instead of warm-starting into a fresh
    `args.steps`-long loop (which would over-train and re-collide step numbers).

    The adapter goes into the bundle as its PEFT state dict (not via the diffusers
    loader) so resume can restore it into the SAME `default` adapter with
    `set_peft_model_state_dict` — round-tripping `get_peft_model_state_dict`
    exactly. Loading the `pytorch_lora_weights.safetensors` back through
    `pipe.load_lora_weights()` would instead inject a SECOND adapter
    (`get_adapter_name` returns `default_<n>` when one already exists), leaving the
    trained weights in `default_1` while export reads `default` — silently wrong.
    Saved on CPU; `load_state_dict` re-casts onto the fp32 on-device params."""
    from peft.utils import get_peft_model_state_dict

    ckpt_dir = out_dir / "checkpoints" / f"step-{step:06d}"
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    state = get_peft_model_state_dict(transformer)
    pipe_cls.save_lora_weights(str(ckpt_dir), transformer_lora_layers=state)
    torch.save(
        {"optimizer": optimizer.state_dict(), "adapter": state, "step": step},
        ckpt_dir / "optimizer.pt",
    )
    (ckpt_dir / "state.json").write_text(json.dumps({"step": step}))
    return ckpt_dir


@torch.no_grad()
def render_sample(pipe, transformer, embeds, text_ids, resolution, device, dtype, seed, out_path: Path):
    """Quick 8-step Euler flow-matching sample with the in-training adapter.
    Best-effort — callers wrap in try/except; a failed sample never fails
    the run."""
    latent_h = 2 * (resolution // (pipe.vae_scale_factor * 2))
    latent_w = 2 * (resolution // (pipe.vae_scale_factor * 2))
    channels = pipe.transformer.config.in_channels // 4 * 4  # packed channel count
    gen = torch.Generator(device="cpu").manual_seed(seed)
    raw = torch.randn((1, channels, latent_h // 2, latent_w // 2), generator=gen).to(device, dtype)
    latent_ids = pipe._prepare_latent_ids(raw).to(device)
    latents = pipe._pack_latents(raw)
    sigmas = torch.linspace(1.0, 0.0, 9)
    for i in range(8):
        sigma = sigmas[i]
        t = sigma.expand(1).to(device, dtype)
        pred = transformer(
            hidden_states=latents.to(dtype),
            timestep=t,
            guidance=None,
            encoder_hidden_states=embeds,
            txt_ids=text_ids,
            img_ids=latent_ids,
            return_dict=False,
        )[0]
        latents = latents - (sigmas[i] - sigmas[i + 1]).to(device, dtype) * pred
    unpacked = pipe._unpack_latents_with_ids(latents, latent_ids, latent_h // 2, latent_w // 2)
    bn_mean = pipe.vae.bn.running_mean.view(1, -1, 1, 1).to(unpacked.device, unpacked.dtype)
    bn_std = torch.sqrt(pipe.vae.bn.running_var.view(1, -1, 1, 1) + pipe.vae.config.batch_norm_eps).to(
        unpacked.device, unpacked.dtype
    )
    unpacked = unpacked * bn_std + bn_mean
    unpacked = pipe._unpatchify_latents(unpacked)
    vae_device = next(pipe.vae.parameters()).device
    image = pipe.vae.decode(unpacked.to(vae_device, pipe.vae.dtype), return_dict=False)[0]
    image = pipe.image_processor.postprocess(image, output_type="pil")[0]
    image.save(out_path)


@install_hf_error_handler
def main():
    args = parse_args()
    from diffusers import Flux2KleinPipeline
    from peft import LoraConfig
    from peft.utils import get_peft_model_state_dict

    device = pick_device(args.device)
    # Apple-Silicon guard: this torch/diffusers trainer can't complete a LoRA
    # backward on Metal. PyTorch's MPS backend has no `linear_backward` for the
    # FLUX.2 transformer's Linear layers (raises "mps_linear_backward:
    # unsupported weights data type" for both bf16 AND fp32 at the first
    # loss.backward()). The preferred Apple-Silicon runtime is mflux (MLX-native,
    # trains bf16 directly); this torch path is the fallback for CUDA/CPU boxes.
    # Fail fast BEFORE loading the ~16 GB base + minutes of latent precompute
    # rather than crashing at the first optimizer step. A forced `--device cpu`
    # is still allowed (fp32 CPU backward works, just slow).
    if device == "mps":
        print(
            "USER_ERROR:TRAINING_UNSUPPORTED_DEVICE:the torch FLUX.2 trainer can't train on "
            "Apple Silicon (Metal/MPS) — PyTorch has no MPS linear_backward for these layers. "
            "Use the mflux runtime instead: install mflux ≥0.17 via scripts/setup-image-video.sh. "
            "(Force --device cpu to train on CPU, but that is impractically slow.)",
            file=sys.stderr, flush=True,
        )
        sys.exit(1)
    dtype = torch.bfloat16 if device != "cpu" else torch.float32
    torch.manual_seed(args.seed)

    out_dir = Path(args.output_dir)
    (out_dir / "samples").mkdir(parents=True, exist_ok=True)
    (out_dir / "checkpoints").mkdir(parents=True, exist_ok=True)

    manifest = json.loads(Path(args.manifest).read_text())
    images = manifest.get("images") or []
    if not images:
        print("USER_ERROR:DATASET_ERROR:manifest contains no images", file=sys.stderr, flush=True)
        sys.exit(2)

    log("STAGE:load-pipeline")
    with heartbeat("load-pipeline"):
        pipe = Flux2KleinPipeline.from_pretrained(args.model_repo, torch_dtype=dtype)

    # ---- Phase 1: precompute text embeddings + image latents ----
    log("STAGE:precompute-latents")
    sample_prompt = args.sample_prompt or f"{args.trigger_word} portrait, neutral background"
    examples = []
    with heartbeat("precompute-latents"):
        pipe.text_encoder.to(device)
        embed_cache = {}
        for entry in images + [{"caption": sample_prompt, "path": None}]:
            caption = entry["caption"]
            if caption not in embed_cache:
                embeds, text_ids = pipe.encode_prompt(caption, device=device)
                embed_cache[caption] = (embeds.to("cpu"), text_ids.to("cpu"))
        sample_embeds = embed_cache[sample_prompt]
        # Free the text encoder — the make-or-break memory move on MPS.
        pipe.text_encoder.to("cpu")
        pipe.text_encoder = None
        gc.collect()
        if device == "mps":
            torch.mps.empty_cache()

        pipe.vae.to(device)
        gen = torch.Generator(device="cpu").manual_seed(args.seed)
        for i, entry in enumerate(images):
            pixel = load_image_tensor(entry["path"], args.resolution).to(device, pipe.vae.dtype)
            latents = pipe._encode_vae_image(pixel, generator=gen)  # (1, C, H, W) normalized
            latent_ids = pipe._prepare_latent_ids(latents)
            packed = pipe._pack_latents(latents)
            embeds, text_ids = embed_cache[entry["caption"]]
            examples.append({
                "packed": packed.to("cpu"),
                "latent_ids": latent_ids.to("cpu"),
                "embeds": embeds,
                "text_ids": text_ids,
            })
            log(f"STATUS:encoded {i + 1}/{len(images)} dataset images")
        # VAE only needed again for samples — keep it, but off-device.
        pipe.vae.to("cpu")
        gc.collect()
        if device == "mps":
            torch.mps.empty_cache()

    # ---- Phase 2: training ----
    log("STAGE:training")
    transformer = pipe.transformer
    transformer.requires_grad_(False)
    targets = lora_target_modules(transformer)
    log(f"STATUS:LoRA targets: {', '.join(targets)} (rank {args.rank})")
    # Always create the single trainable `default` adapter (gaussian init). On
    # resume its weights are overwritten in-place below from the checkpoint's
    # PEFT state dict — NOT via pipe.load_lora_weights(), which would inject a
    # second `default_<n>` adapter and leave training/export out of sync.
    transformer.add_adapter(LoraConfig(
        r=args.rank,
        lora_alpha=args.rank,
        init_lora_weights="gaussian",
        target_modules=targets,
    ))
    transformer.enable_gradient_checkpointing()
    transformer.to(device)
    transformer.train()

    trainable = [p for p in transformer.parameters() if p.requires_grad]
    # LoRA params train in fp32 for AdamW stability even when the base is bf16.
    for p in trainable:
        p.data = p.data.to(torch.float32)
    optimizer = torch.optim.AdamW(trainable, lr=args.lr, weight_decay=0.01)

    # Resume: restore the adapter weights, AdamW state, and a starting-step
    # offset from the checkpoint's optimizer.pt bundle, so the loop continues
    # toward the ORIGINAL total (range(start_step + 1, args.steps + 1)) with warm
    # momentum instead of re-running a fresh args.steps from a random adapter.
    # The adapter is loaded into the existing `default` adapter via
    # set_peft_model_state_dict (in-place — param identities, and therefore the
    # optimizer state alignment, are preserved). The server only hands us
    # checkpoints that carry optimizer.pt (resolveLatestCheckpointArtifact gates
    # on it); a checkpoint that predates optimizer-state resume is a hard error
    # rather than a silent cold-start onto the random gaussian adapter. (RNG
    # state is intentionally not restored; the per-step noise/timestep sequence
    # restarts from the seed, immaterial to quality — the load-bearing fix is
    # adapter + optimizer + step.)
    start_step = 0
    if args.resume_from:
        from peft.utils import set_peft_model_state_dict

        opt_file = Path(args.resume_from) / "optimizer.pt"
        if not opt_file.exists():
            print(
                f"USER_ERROR:TRAINING_FAILED:resume checkpoint has no optimizer state ({opt_file}) — "
                "it predates optimizer-state resume; start a fresh run",
                file=sys.stderr, flush=True,
            )
            sys.exit(1)
        ckpt = torch.load(opt_file, map_location="cpu")
        set_peft_model_state_dict(transformer, ckpt["adapter"], adapter_name="default")
        optimizer.load_state_dict(ckpt["optimizer"])
        start_step = int(ckpt.get("step", 0))
        log(f"STATUS:resumed adapter + optimizer state — continuing from step {start_step}")
        if start_step >= args.steps:
            log(f"STATUS:resume point (step {start_step}) already at/past target {args.steps} — nothing to train")

    order = list(range(len(examples)))
    rng = torch.Generator().manual_seed(args.seed)
    final_loss = None
    last_checkpoint = None

    for step in range(start_step + 1, args.steps + 1):
        if (step - 1) % len(order) == 0:
            order = torch.randperm(len(examples), generator=rng).tolist()
        ex = examples[order[(step - 1) % len(order)]]
        packed = ex["packed"].to(device, dtype)
        latent_ids = ex["latent_ids"].to(device)
        embeds = ex["embeds"].to(device, dtype)
        text_ids = ex["text_ids"].to(device)

        noise = torch.randn_like(packed)
        # Logit-normal timestep sampling (FLUX training recipe).
        sigma = torch.sigmoid(torch.randn((1,), generator=rng)).to(device, dtype)
        noisy = (1.0 - sigma) * packed + sigma * noise
        target = noise - packed

        pred = transformer(
            hidden_states=noisy,
            timestep=sigma.expand(1),
            guidance=None,
            encoder_hidden_states=embeds,
            txt_ids=text_ids,
            img_ids=latent_ids,
            return_dict=False,
        )[0]
        loss = torch.nn.functional.mse_loss(pred.float(), target.float())
        loss.backward()
        torch.nn.utils.clip_grad_norm_(trainable, 1.0)
        optimizer.step()
        optimizer.zero_grad(set_to_none=True)

        final_loss = float(loss.detach().item())
        log(f"STEP:{step}:{args.steps}:{final_loss:.4f}")

        if STOP_REQUESTED:
            ckpt = save_checkpoint(Flux2KleinPipeline, transformer, optimizer, out_dir, step)
            log(f"CHECKPOINT:{ckpt}:{step}")
            log("STATUS:canceled-checkpoint-saved")
            os._exit(143)

        if args.checkpoint_every > 0 and step % args.checkpoint_every == 0 and step < args.steps:
            ckpt = save_checkpoint(Flux2KleinPipeline, transformer, optimizer, out_dir, step)
            last_checkpoint = ckpt
            log(f"CHECKPOINT:{ckpt}:{step}")

        if args.sample_every > 0 and step % args.sample_every == 0:
            sample_path = out_dir / "samples" / f"step-{step:06d}.png"
            transformer.eval()
            try:
                render_sample(
                    pipe, transformer, sample_embeds[0].to(device, dtype), sample_embeds[1].to(device),
                    args.resolution, device, dtype, args.seed, sample_path,
                )
                log(f"SAMPLE:{sample_path}:{step}")
            except Exception as err:  # noqa: BLE001 — samples are best-effort, never fail the run
                log(f"STATUS:sample render failed (training continues): {err}")
            finally:
                transformer.train()
                if device == "mps":
                    torch.mps.empty_cache()

    # ---- Finalize ----
    adapter_dir = out_dir / "adapter"
    adapter_dir.mkdir(parents=True, exist_ok=True)
    state = get_peft_model_state_dict(transformer)
    Flux2KleinPipeline.save_lora_weights(str(adapter_dir), transformer_lora_layers=state)
    adapter_path = adapter_dir / "pytorch_lora_weights.safetensors"
    if not adapter_path.exists():
        candidates = list(adapter_dir.glob("*.safetensors"))
        if not candidates:
            print("USER_ERROR:TRAINING_FAILED:adapter save produced no .safetensors", file=sys.stderr, flush=True)
            sys.exit(1)
        adapter_path = candidates[0]
    log("RESULT:" + json.dumps({
        "adapter_path": str(adapter_path),
        "steps": args.steps,
        "final_loss": final_loss,
        "last_checkpoint": str(last_checkpoint) if last_checkpoint else None,
    }))
    # Hard-exit defense against teardown hangs (mirrors the video runtimes).
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
