#!/usr/bin/env python3
"""Cache-only PortOS runner for MiniMax H3-Image on Apple Silicon (MLX).

Upstream ships MiniMax H3-Image for CUDA only (SGLang). This adapter runs it
on the pinned PipeNetwork MiniMax H3 MLX source checkout PortOS already
installs for H3 video. The image release keeps the video model's architecture
(same 50-block DiT, same Qwen3-VL conditioner), so only the image-specific
parts live here:

* the request presentation: per reference "Picture i: " plus its vision block,
  then the prompt;
* the ref2va packed layout with latent_t = 1 and no audio rows: text rows,
  then one block per reference image, then the target image;
* the 6-step PDD sampler: plain Euler on the target rows, with a per-step
  output head (``pdd_fused_heads.safetensors``) replacing
  ``final_layer.video_out``. Reference anchors stay at t = 0.999;
* the image VAE: the same causal CNN encoder and a 2D ViT decoder.

Network access is never attempted. Each file is resolved from the Hugging Face
cache at its pinned revision, and a missing file tells the user to download
the model in Image Gen. The text encoder comes from the H3 video repo, whose
blobs are identical to the ones the image release expects.

Memory: the conditioner (about 50 GB at bf16) is freed before the DiT loads.
The DiT's AdaLN projections are folded into a precomputed table and dropped,
which leaves it about 40 GB resident.
"""

from __future__ import annotations

import argparse
import gc
import json
import math
import signal
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _runner_common import (  # noqa: E402
    emit_runtime_fingerprint, establish_process_group, heartbeat, register_source_namespace,
)
from _minimax_h3_common import resolve_cached_snapshot  # noqa: E402

# Release recipe (SGLang minimax_h3_image pipeline config).
MAX_REFERENCES = 16
PIXEL_GRID = 32
MAX_PIXELS = 20_000_000
MAX_ASPECT = 3.0
DEFAULT_MIN_GENERATION_AREA = 2048 * 2048
QWEN_REFERENCE_SHORT_EDGE = (1024, 1024)
VAE_REFERENCE_SHORT_EDGE = (1024, 2048)
TEXT_SEGMENT_TOKENS = 4096
CONDITION_TIMESTEP = 0.999
PIXEL_MEAN = (0.485, 0.456, 0.406)
PIXEL_STD = (0.229, 0.224, 0.225)
TAG_VIDEO, TAG_TEXT = 0, 1
TEXT_ENCODER_SUBDIR = "FL2VA"

IMAGE_FILES = [
    "model_index.json", "pdd_config.json", "pdd_fused_heads.safetensors",
    "transformer/config.json", "transformer/model.safetensors.index.json",
    "vae/config.json", "vae/diffusion_pytorch_model.safetensors",
]


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--runtime-revision", required=True)
    parser.add_argument("--model-repo", required=True)
    parser.add_argument("--model-revision", required=True)
    parser.add_argument("--text-encoder-repo", required=True)
    parser.add_argument("--text-encoder-revision", required=True)
    parser.add_argument("--text-encoder-file", action="append", default=[],
                        help="cached file under the text-encoder repo (repeatable)")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--steps", type=int, default=6)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--reference-image", action="append", default=[])
    parser.add_argument("--min-generation-area", type=int, default=DEFAULT_MIN_GENERATION_AREA)
    return parser.parse_args(argv)


def validate_args(args: argparse.Namespace) -> None:
    if not args.prompt.strip():
        raise SystemExit("MiniMax H3-Image needs a prompt.")
    if len(args.reference_image) > MAX_REFERENCES:
        raise SystemExit(f"MiniMax H3-Image accepts at most {MAX_REFERENCES} reference images.")
    w, h = args.width, args.height
    # Any size works: the DiT renders a 32px-aligned same-aspect canvas
    # (enlarged below --min-generation-area) and the result is resized back.
    if w <= 0 or h <= 0:
        raise SystemExit("MiniMax H3-Image needs a positive width and height.")
    if w * h > MAX_PIXELS:
        raise SystemExit(f"MiniMax H3-Image renders at most {MAX_PIXELS:,} pixels.")
    if max(w, h) > MAX_ASPECT * min(w, h):
        raise SystemExit("MiniMax H3-Image supports aspect ratios from 1:3 to 3:1.")
    if not 0 <= args.seed <= 2 ** 32 - 1:
        raise SystemExit("--seed must be an unsigned 32-bit integer.")


# --- geometry (pure, unit-tested) -------------------------------------------

def nearest_multiple(value: float, multiple: int) -> int:
    return max(multiple, int(round(value / multiple)) * multiple)


def generation_canvas(width: int, height: int, min_area: int) -> tuple[int, int]:
    """The 32px-aligned canvas the DiT renders; below ``min_area`` it is enlarged."""
    scale = max(1.0, math.sqrt(min_area / (width * height)))
    return nearest_multiple(width * scale, PIXEL_GRID), nearest_multiple(height * scale, PIXEL_GRID)


def bounded_reference_size(width: int, height: int, bounds: tuple[int, int]) -> tuple[int, int] | None:
    """Rescale a reference whose short edge is outside ``bounds``; None keeps it."""
    low, high = bounds
    short = min(width, height)
    if low <= short <= high:
        return None
    scale = (low if short < low else high) / short
    return nearest_multiple(width * scale, PIXEL_GRID), nearest_multiple(height * scale, PIXEL_GRID)


def bound_reference(image, bounds):
    from PIL import Image

    size = bounded_reference_size(*image.size, bounds)
    return image if size is None else image.resize(size, Image.Resampling.LANCZOS)


def spatial_axis(dim: int, patch: int, sqrt_area: float):
    import numpy as np

    ratio = dim / sqrt_area
    left = (1.0 - ratio) / 2.0
    return np.linspace(left, left + ratio, dim // patch, endpoint=False) * 32.0


def frame_positions(latent_h: int, latent_w: int):
    import numpy as np

    area = math.sqrt(latent_h * latent_w)
    hh, ww = np.meshgrid(spatial_axis(latent_h, 2, area), spatial_axis(latent_w, 2, area), indexing="ij")
    return np.stack([hh.reshape(-1), ww.reshape(-1)], axis=-1)


def build_layout(text_tags, ref_grids, latent_h: int, latent_w: int) -> dict:
    """``[text | reference blocks | target]`` rows for one image request."""
    import numpy as np

    text_len = len(text_tags)
    blocks = [frame_positions(h, w) for h, w in ref_grids]
    target = frame_positions(latent_h, latent_w)
    n_cond = sum(len(b) for b in blocks)
    seq = text_len + n_cond + len(target)
    pos = np.zeros((seq, 3), dtype=np.float64)
    pos[:text_len, 0] = np.arange(text_len, dtype=np.float64)
    cursor = text_len
    for index, block in enumerate(blocks):
        pos[cursor:cursor + len(block), 0] = text_len + index
        pos[cursor:cursor + len(block), 1:] = block
        cursor += len(block)
    pos[cursor:, 0] = text_len + len(blocks)
    pos[cursor:, 1:] = target
    tags = np.full(seq, TAG_VIDEO, dtype=np.int32)
    tags[:text_len] = np.asarray(text_tags, dtype=np.int32)
    return {"text_len": text_len, "n_cond": n_cond, "seq_len": seq,
            "position_ids": pos.astype(np.float32), "token_tags": tags}


def timestep_plan(sigmas, layout: dict):
    """One timestep table for the whole run plus per-step row indices into it."""
    import numpy as np

    steps = [float(np.float32(1.0) - np.float32(s)) for s in sigmas[:-1]]
    values = set(steps)
    if layout["n_cond"]:
        values.add(float(np.float32(CONDITION_TIMESTEP)))
    table = sorted(values)
    lookup = {v: i for i, v in enumerate(table)}
    cond = slice(layout["text_len"], layout["text_len"] + layout["n_cond"])
    plan = []
    for t in steps:
        rows = np.full(layout["seq_len"], lookup[t], dtype=np.int32)
        rows[cond] = lookup.get(float(np.float32(CONDITION_TIMESTEP)), 0)
        plan.append(rows)
    return np.asarray(table, dtype=np.float32), plan


# --- text conditioning ------------------------------------------------------

def encode_prompt(encoder, prompt: str, images: list):
    """Image-release presentation through the truncated Qwen3-VL stack.

    Labels read "Picture i: " (the video release uses "<Picture i>: "), every
    text segment is capped at 4096 tokens and the whole vision block is tagged
    video. Returns ``(hidden_states, token_tags)``.
    """
    import mlx.core as mx
    import numpy as np

    tok = encoder.tokenizer

    def text_ids(text):
        return list(tok(text, add_special_tokens=False)["input_ids"])[:TEXT_SEGMENT_TOKENS]

    ids, tags, grid_thw, pixel_values = [], [], None, None
    if images:
        processor = encoder.processor.image_processor
        vision = processor(images=[bound_reference(i, QWEN_REFERENCE_SHORT_EDGE) for i in images], return_tensors="np")
        pixel_values = np.asarray(vision["pixel_values"])
        grid_thw = np.asarray(vision["image_grid_thw"])
        merge = int(processor.merge_size) ** 2
        start = tok.convert_tokens_to_ids("<|vision_start|>")
        pad = tok.convert_tokens_to_ids("<|image_pad|>")
        end = tok.convert_tokens_to_ids("<|vision_end|>")
        for index in range(len(images)):
            label = text_ids(f"Picture {index + 1}: ")
            block = [start] + [pad] * (int(grid_thw[index].prod()) // merge) + [end]
            ids += label + block
            tags += [TAG_TEXT] * len(label) + [TAG_VIDEO] * len(block)
    prompt_ids = text_ids(prompt)
    ids += prompt_ids
    tags += [TAG_TEXT] * len(prompt_ids)

    from mlx_vlm.models.qwen3_vl.language import LanguageModel

    input_ids = mx.array(np.array([ids], dtype=np.int32))
    inputs_embeds = visual_mask = deepstack = grid = None
    if images:
        from mlx_vlm.models.qwen3_vl.qwen3_vl import Model

        grid = mx.array(grid_thw.astype(np.int32))
        hidden, deepstack = encoder.vision(mx.array(pixel_values).astype(encoder.dtype), grid, output_hidden_states=True)
        inputs_embeds = encoder.language.embed_tokens(input_ids)
        inputs_embeds, image_mask = Model.merge_input_ids_with_image_features(
            hidden.astype(inputs_embeds.dtype), inputs_embeds, input_ids,
            encoder.image_token_id, encoder.image_token_id,
        )
        visual_mask = image_mask[..., 0]
    position_ids, _ = LanguageModel.get_rope_index(encoder, input_ids, image_grid_thw=grid, video_grid_thw=None, attention_mask=None)
    states = encoder._hidden_states(input_ids, position_ids, inputs_embeds=inputs_embeds,
                                    visual_pos_masks=visual_mask, deepstack_visual_embeds=deepstack)
    mx.eval(states)
    return states, np.asarray(tags, dtype=np.int32)


# --- image VAE --------------------------------------------------------------

def build_image_vae(vae_dir: Path):
    """CNN encoder (shared with the video VAE) plus the 2D ViT decoder."""
    import mlx.core as mx
    import mlx.nn as nn
    from mlx.utils import tree_flatten, tree_unflatten
    from minimax_h3_mlx.video_vae import CausalConv3d, Encoder3d, VideoVAE, VideoVAEConfig, ViTBlock, ViTRotaryPosEmbed

    raw = json.loads((vae_dir / "config.json").read_text(encoding="utf-8"))
    vit = raw.get("vit_decoder_kwargs", {})
    ch = raw.get("ch", 128)
    config = VideoVAEConfig(
        in_channels=raw.get("in_channels", 3),
        latent_channels=raw.get("latent_channels", raw.get("z_channels", 24)),
        block_out_channels=tuple(ch * m for m in raw.get("ch_mult", (1, 2, 2, 4, 4, 8))),
        layers_per_block=raw.get("num_res_blocks", 2),
        spatial_downsample_factors=tuple(raw.get("space_down", (2, 2, 2, 2, 1, 1))),
        temporal_downsample_factors=tuple(raw.get("time_down", (1, 2, 2, 1, 1, 1))),
        decoder_num_layers=vit.get("num_layers", 24),
        decoder_num_attention_heads=vit.get("heads", 16),
        decoder_attention_head_dim=vit.get("dim_head", 64),
        decoder_rope_theta=vit.get("rope_theta", 100.0),
        decoder_rope_dim_ratio=vit.get("rope_dim_ratio", 0.5),
        latents_mean=tuple(raw["latents_mean"]),
        latents_std=tuple(raw["latents_std"]),
    )
    patch = config.spatial_compression_ratio

    class ViTDecoder2d(nn.Module):
        """Each latent pixel is a token; registers + one zero token sit at position 0."""

        def __init__(self):
            super().__init__()
            dim = config.decoder_dim
            self.num_register_tokens = config.decoder_num_register_tokens
            self.rope = ViTRotaryPosEmbed(int(config.decoder_attention_head_dim * config.decoder_rope_dim_ratio),
                                          theta=config.decoder_rope_theta, num_axes=2)
            self.x_embedder = nn.Linear(config.latent_channels, dim)
            self.register_tokens = mx.zeros((1, self.num_register_tokens, dim))
            self.transformer_blocks = [
                ViTBlock(dim, config.decoder_num_attention_heads, config.decoder_attention_head_dim,
                         config.decoder_ffn_mult, config.decoder_norm_eps)
                for _ in range(config.decoder_num_layers)
            ]
            self.norm_out = nn.LayerNorm(dim, eps=config.decoder_norm_eps, affine=True)
            self.proj_out = nn.Linear(dim, 3 * patch * patch)

        def __call__(self, z):
            b, h, w, c = z.shape
            tokens = self.x_embedder(z.reshape(b, h * w, c))
            n = tokens.shape[1]
            registers = mx.broadcast_to(self.register_tokens, (b, self.num_register_tokens, tokens.shape[-1]))
            tokens = mx.concatenate([tokens, registers.astype(tokens.dtype), mx.zeros((b, 1, tokens.shape[-1]), tokens.dtype)], axis=1)
            gh = 2.0 * ((mx.arange(h, dtype=mx.float32) + 0.5) / h) - 1.0
            gw = 2.0 * ((mx.arange(w, dtype=mx.float32) + 0.5) / w) - 1.0
            grid = mx.stack([mx.broadcast_to(gh.reshape(h, 1), (h, w)), mx.broadcast_to(gw.reshape(1, w), (h, w))], axis=-1)
            pos = mx.concatenate([mx.broadcast_to(grid.reshape(1, h * w, 2), (b, h * w, 2)),
                                  mx.zeros((b, self.num_register_tokens + 1, 2), mx.float32)], axis=1)
            rotary = self.rope(pos)
            for block in self.transformer_blocks:
                tokens = block(tokens, rotary)
            out = self.proj_out(self.norm_out(tokens))[:, :n, :]
            out = out.reshape(b, h, w, 3, patch, patch).transpose(0, 1, 4, 2, 5, 3)
            return out.reshape(b, h * patch, w * patch, 3)

    class ImageVAE(VideoVAE):
        # Borrows VideoVAE's tiling helpers; the module tree is the image release's.
        def __init__(self):
            nn.Module.__init__(self)
            self.config = config
            self.encoder = Encoder3d(config)
            self.quant_conv = CausalConv3d(2 * config.latent_channels, 2 * config.latent_channels, 1)
            self.post_quant_conv = nn.Linear(config.latent_channels, config.latent_channels)
            self.decoder = ViTDecoder2d()
            self.tile = int(raw.get("vae_tile_size", 256))
            self.overlap = int(raw.get("vae_tile_overlap_min", raw.get("tile_overlap_min", 64)))
            self.use_tiling = True
            self.tile_sample_min_height = self.tile_sample_min_width = self.tile
            self.tile_sample_min_overlap_height = self.tile_sample_min_overlap_width = self.overlap

        def decode_image(self, z):
            """``z`` is channels-last ``(B, h, w, C)`` latents; returns ``(B, H, W, 3)``."""
            h, w = z.shape[1] * patch, z.shape[2] * patch
            ys, yl, yo = self._split_tiles(h, self.tile, self.overlap)
            xs, xl, xo = self._split_tiles(w, self.tile, self.overlap)
            rows = []
            for i_pos, i_len in zip(ys, yl):
                row = []
                for j_pos, j_len in zip(xs, xl):
                    tile = z[:, i_pos // patch:(i_pos + i_len) // patch, j_pos // patch:(j_pos + j_len) // patch, :]
                    out = self.decoder(self.post_quant_conv(tile))
                    mx.eval(out)
                    row.append(out)
                rows.append(row)
            return self._stitch_tiles(rows, yo, xo, 1, 2)

    vae = ImageVAE()
    expected = {key for key, _ in tree_flatten(vae.parameters())}
    weights, unexpected = {}, []
    for key, tensor in mx.load(str(vae_dir / "diffusion_pytorch_model.safetensors")).items():
        if key == "decoder.mask_token":
            continue  # masked-autoencoding training buffer; inference never reads it
        if key == "post_quant_conv.weight":
            tensor = tensor.reshape(tensor.shape[0], tensor.shape[1])
        elif tensor.ndim == 5:
            with mx.stream(mx.cpu):
                tensor = mx.contiguous(tensor.transpose(0, 2, 3, 4, 1))
                mx.eval(tensor)
        if key not in expected:
            unexpected.append(key)
            continue
        weights[key] = tensor
    missing = sorted(expected - weights.keys())
    if missing or unexpected:
        raise RuntimeError(f"Image VAE mismatch: {len(missing)} missing (e.g. {missing[:3]}), "
                           f"{len(unexpected)} unexpected (e.g. {unexpected[:3]}). Repair the model in Image Gen.")
    vae.update(tree_unflatten(list(weights.items())))
    mx.eval(vae.parameters())
    return vae


def encode_references(vae, images, noise_keys, posterior_keys, patch_size):
    """Clean, normalized ref rows and their 0.999 anchors, in packed order."""
    import mlx.core as mx
    import numpy as np
    from minimax_h3_mlx.packing import patchify_video_latents

    cfg = vae.config
    c = cfg.latent_channels
    mean = mx.array(np.array(cfg.latents_mean, np.float32)).reshape(1, -1, 1, 1, 1)
    std = mx.array(np.array(cfg.latents_std, np.float32)).reshape(1, -1, 1, 1, 1)
    anchors, grids = [], []
    for image, noise_key, post_key in zip(images, noise_keys, posterior_keys):
        image = bound_reference(image, VAE_REFERENCE_SHORT_EDGE)
        w, h = image.size
        pixels = np.asarray(image, dtype=np.float32)[: h // 16 * 16, : w // 16 * 16] / 255.0
        pixels = (pixels - np.array(PIXEL_MEAN, np.float32)) / np.array(PIXEL_STD, np.float32)
        moments = vae._encode_clip(mx.array(pixels)[None, None])  # (1, 1, h', w', 2C)
        mu, logvar = moments[..., :c], mx.clip(moments[..., c:], -30.0, 20.0)
        latent = mu + mx.exp(0.5 * logvar) * mx.random.normal(mu.shape, key=post_key)
        latent = latent.astype(mx.float16).astype(mx.float32).transpose(0, 4, 1, 2, 3)
        lh, lw = latent.shape[-2] // 2 * 2, latent.shape[-1] // 2 * 2
        latent = (latent[..., :lh, :lw] - mean) / std
        rows = patchify_video_latents(latent, patch_size)
        noise = mx.random.normal(rows.shape, key=noise_key)
        anchors.append(CONDITION_TIMESTEP * rows + (1.0 - CONDITION_TIMESTEP) * noise)
        grids.append((lh, lw))
        mx.eval(anchors[-1])
    return (mx.concatenate(anchors) if anchors else None), grids


# --- DiT --------------------------------------------------------------------

def load_dit_with_heads(transformer_dir: Path, heads_path: Path, steps: int):
    import mlx.core as mx
    from minimax_h3_mlx.load import load_dit

    dit = load_dit(transformer_dir, strict=False)
    heads = mx.load(str(heads_path))
    weight = next((v for k, v in heads.items() if k.endswith("video_out.weight")), None)
    bias = next((v for k, v in heads.items() if k.endswith("video_out.bias")), None)
    if weight is None or bias is None or weight.ndim != 3 or weight.shape[0] != steps:
        raise RuntimeError(f"PDD heads do not match a {steps}-step schedule; repair the model in Image Gen.")
    return dit, weight.astype(mx.float32), bias.astype(mx.float32)


def dit_velocity(dit, rows, text_embeds, layout_mx, table, step_rows, cache, head_w, head_b):
    """Audio-free H3 forward returning the PDD-head velocity of the target rows."""
    import mlx.core as mx
    from minimax_h3_mlx.config import MODALITY_NUM
    from minimax_h3_mlx.dit import param_dtype, timestep_embedding

    text_len, seq = layout_mx["text_len"], layout_mx["seq_len"]
    rotary = dit.rope(layout_mx["position_ids"])
    text = dit.token_refiner(dit.condition_proj(text_embeds.astype(param_dtype(dit.condition_proj))))
    media = dit.video_patch_proj(rows.astype(param_dtype(dit.video_patch_proj)))
    x = mx.concatenate([text, media.astype(text.dtype)], axis=1)
    if x.shape[1] != seq:
        raise RuntimeError(f"Packed sequence has {x.shape[1]} rows, expected {seq}.")
    temb = dit.time_embedder(timestep_embedding(table, dit.config.timestep_input_dim))
    adaln = step_rows * MODALITY_NUM + mx.maximum(layout_mx["token_tags"], 0)
    for i, block in enumerate(dit.blocks):
        x = block(x, cache.get(i), adaln, rotary)
    start = text_len + layout_mx["n_cond"]
    target = dit.final_layer.norm_out(x[:, start:], temb, step_rows[start:])
    return target.astype(mx.float32) @ head_w.T + head_b


# --- main -------------------------------------------------------------------

def load_references(paths):
    from PIL import Image, ImageOps

    images = []
    for path in paths:
        with Image.open(path) as source:
            if getattr(source, "n_frames", 1) != 1:
                raise SystemExit(f"Reference image must not be animated: {Path(path).name}")
            images.append(ImageOps.exif_transpose(source).convert("RGB"))
    return images


def progress(step: int, total: int) -> None:
    pct = int(step * 100 / total)
    print(f"{pct}%|{'#' * (pct // 10)}| {step}/{total}", file=sys.stderr, flush=True)


def main(argv=None) -> int:
    signal.signal(signal.SIGTERM, lambda signum, _frame: (_ for _ in ()).throw(SystemExit(128 + signum)))
    args = parse_args(argv)
    validate_args(args)
    references = load_references(args.reference_image)
    establish_process_group()

    from generate_minimax_h3 import (
        load_pil_image_processor, sanitize_vision_weights, torch_image_stack_available, verify_runtime_checkout,
    )

    runtime_dir = Path(args.runtime_dir).resolve()
    verify_runtime_checkout(runtime_dir, args.runtime_revision)
    emit_runtime_fingerprint("minimax_h3_image", ["mlx", "mlx-metal", "mlx-vlm", "transformers", "huggingface-hub"])

    print("STAGE:resolve-cache", file=sys.stderr, flush=True)
    image_root = resolve_cached_snapshot(args.model_repo, args.model_revision, IMAGE_FILES)
    index = json.loads((image_root / "transformer/model.safetensors.index.json").read_text(encoding="utf-8"))
    resolve_cached_snapshot(args.model_repo, args.model_revision,
                            [f"transformer/{s}" for s in sorted(set(index["weight_map"].values()))])
    text_root = resolve_cached_snapshot(args.text_encoder_repo, args.text_encoder_revision, args.text_encoder_file)
    sigmas = json.loads((image_root / "pdd_config.json").read_text(encoding="utf-8"))["sigmas"]
    if len(sigmas) - 1 != args.steps:
        raise SystemExit(f"MiniMax H3-Image is distilled for {len(sigmas) - 1} steps.")

    register_source_namespace("minimax_h3_mlx", runtime_dir / "minimax_h3_mlx")
    import mlx.core as mx
    import numpy as np
    from PIL import Image
    from minimax_h3_mlx.adaln import ModulationCache, drop_adaln_weights
    from minimax_h3_mlx.packing import patchify_video_latents, unpatchify_video_tokens
    from minimax_h3_mlx.text_encoder import MiniMaxH3TextEncoder

    canvas_w, canvas_h = generation_canvas(args.width, args.height, args.min_generation_area)
    latent_h, latent_w = canvas_h // 16, canvas_w // 16
    patch_size = (1, 2, 2)
    target_key, *ref_keys = mx.random.split(mx.random.key(args.seed), 1 + 2 * len(references)) if references \
        else [mx.random.key(args.seed)]
    noise_keys, posterior_keys = ref_keys[:len(references)], ref_keys[len(references):]
    started = time.perf_counter()

    print("STAGE:load-vae", file=sys.stderr, flush=True)
    with heartbeat("load-vae"):
        vae = build_image_vae(image_root / "vae")
    anchors, ref_grids = None, []
    if references:
        print("STAGE:encode-references", file=sys.stderr, flush=True)
        with heartbeat("encode-references"):
            anchors, ref_grids = encode_references(vae, references, noise_keys, posterior_keys, patch_size)

    print("STAGE:encode-prompt", file=sys.stderr, flush=True)
    with heartbeat("encode-prompt"):
        encoder = MiniMaxH3TextEncoder(text_root / TEXT_ENCODER_SUBDIR / "text_encoder", load_vision=bool(references))
        sanitize_vision_weights(encoder.vision)
        if references and not torch_image_stack_available():
            from types import SimpleNamespace

            encoder._processor = SimpleNamespace(
                image_processor=load_pil_image_processor(text_root / TEXT_ENCODER_SUBDIR / "processor"))
        text_embeds, text_tags = encode_prompt(encoder, args.prompt, references)
        text_embeds = text_embeds.astype(mx.bfloat16)
        mx.eval(text_embeds)
        del encoder
        gc.collect()
        mx.clear_cache()

    layout = build_layout(text_tags, ref_grids, latent_h, latent_w)
    table, plan = timestep_plan(sigmas, layout)
    print(f"STATUS:MiniMax H3-Image {canvas_w}x{canvas_h} · {len(references)} reference(s) · "
          f"{layout['seq_len']:,} rows", file=sys.stderr, flush=True)

    print("STAGE:load-pipeline", file=sys.stderr, flush=True)
    with heartbeat("load-pipeline"):
        dit, head_w, head_b = load_dit_with_heads(image_root / "transformer", image_root / "pdd_fused_heads.safetensors", args.steps)
        table_mx = mx.array(table)
        cache = ModulationCache.build(dit, table_mx, dtype=mx.bfloat16)
        drop_adaln_weights(dit)
        gc.collect()
        mx.clear_cache()

    layout_mx = {
        "text_len": layout["text_len"], "n_cond": layout["n_cond"], "seq_len": layout["seq_len"],
        "position_ids": mx.array(layout["position_ids"]), "token_tags": mx.array(layout["token_tags"]),
    }
    noise = mx.random.normal((1, 24, 1, latent_h, latent_w), key=target_key)
    target = patchify_video_latents(noise, patch_size).astype(mx.float32)
    deltas = [float(np.float32(a) - np.float32(b)) for a, b in zip(sigmas[:-1], sigmas[1:])]

    print("STAGE:inference", file=sys.stderr, flush=True)
    progress(0, args.steps)
    with heartbeat("inference"):
        for step in range(args.steps):
            rows = target if anchors is None else mx.concatenate([anchors, target])
            velocity = dit_velocity(dit, rows[None].astype(mx.bfloat16), text_embeds, layout_mx, table_mx,
                                    mx.array(plan[step]), cache, head_w[step], head_b[step])
            target = target + deltas[step] * velocity[0]
            mx.eval(target)
            progress(step + 1, args.steps)

    del dit, cache
    gc.collect()
    mx.clear_cache()

    print("STAGE:decode", file=sys.stderr, flush=True)
    with heartbeat("decode"):
        cfg = vae.config
        latents = unpatchify_video_tokens(target, 1, latent_h, latent_w, cfg.latent_channels, patch_size)
        latents = latents * mx.array(np.array(cfg.latents_std, np.float32)).reshape(1, -1, 1, 1, 1) \
            + mx.array(np.array(cfg.latents_mean, np.float32)).reshape(1, -1, 1, 1, 1)
        pixels = np.array(vae.decode_image(latents[:, :, 0].transpose(0, 2, 3, 1)))[0]
    pixels = np.clip(pixels * np.array(PIXEL_STD, np.float32) + np.array(PIXEL_MEAN, np.float32), 0.0, 1.0)
    image = Image.fromarray((pixels * 255.0).astype(np.uint8))
    if image.size != (args.width, args.height):
        image = image.resize((args.width, args.height), Image.Resampling.LANCZOS)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output)
    print(f"STATUS:MiniMax H3-Image finished in {time.perf_counter() - started:.0f}s", file=sys.stderr, flush=True)
    print(json.dumps({"image_path": str(output)}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
