"""
Windows image generation backend using diffusers + local Flux model files.
Accepts the same CLI args as mflux-generate so imagine.js needs no change.
"""
import argparse
import json
import os
import sys
import warnings

warnings.filterwarnings('ignore')
os.environ['XFORMERS_DISABLED'] = '1'
# Avoid protobuf descriptor crash when converting T5 slow tokenizer
os.environ['PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION'] = 'python'

import torch
from diffusers import AutoencoderKL, FluxPipeline, FluxTransformer2DModel
from diffusers.schedulers import FlowMatchEulerDiscreteScheduler
from safetensors.torch import load_file
from transformers import (
    CLIPTextConfig, CLIPTextModel, CLIPTokenizer,
    T5Config, T5EncoderModel, T5TokenizerFast,
)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
DOWNLOADS = os.path.join(os.path.expanduser('~'), 'Downloads')
HF_FLUX_CACHE = None  # resolved at runtime

FLUX_FILES = {
    'schnell': os.path.join(DOWNLOADS, 'flux1-schnell-fp8.safetensors'),
    'dev':     os.path.join(DOWNLOADS, 'flux1-dev-fp8.safetensors'),
}
VAE_FILE   = os.path.join(DOWNLOADS, 'ae.safetensors')
CLIP_FILE  = os.path.join(DOWNLOADS, 'clip_l.safetensors')
T5_FILE    = os.path.join(DOWNLOADS, 't5xxl_fp16.safetensors')

MODEL_ID_MAP = {
    'schnell':        'schnell',
    'flux2-klein-4b': 'schnell',
    'flux2-klein-9b': 'dev',
    'dev':            'dev',
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def log(msg):
    print(msg, file=sys.stderr, flush=True)


def find_flux_hf_cache():
    """Return the local snapshot dir for FLUX.1-schnell configs."""
    hub = os.path.join(os.path.expanduser('~'), '.cache', 'huggingface', 'hub')
    snap_root = os.path.join(hub, 'models--black-forest-labs--FLUX.1-schnell', 'snapshots')
    if not os.path.isdir(snap_root):
        return None
    snaps = sorted(os.listdir(snap_root))
    return os.path.join(snap_root, snaps[-1]) if snaps else None


def progress_callback(pipe, step, timestep, callback_kwargs):
    total = pipe._num_timesteps
    pct = int((step + 1) / total * 100)
    bar = '█' * (pct // 5) + '▒' * (20 - pct // 5)
    log(f'{pct}%|{bar}| {step + 1}/{total}')
    return callback_kwargs


def build_pipeline(flux_key, hf_cache, dtype):
    log(f'STATUS:Loading tokenizers...')
    tokenizer = CLIPTokenizer.from_pretrained(hf_cache, subfolder='tokenizer')
    # Load T5 fast tokenizer from pre-built tokenizer.json to avoid protobuf/spiece issues
    t2_tok_file = os.path.join(hf_cache, 'tokenizer_2', 'tokenizer.json')
    tokenizer_2 = T5TokenizerFast(
        tokenizer_file=t2_tok_file,
        model_max_length=512,
        legacy=False,
    )
    scheduler = FlowMatchEulerDiscreteScheduler.from_pretrained(hf_cache, subfolder='scheduler')

    log('STATUS:Loading CLIP text encoder...')
    clip_cfg     = CLIPTextConfig.from_pretrained(os.path.join(hf_cache, 'text_encoder'))
    text_encoder = CLIPTextModel(clip_cfg)
    text_encoder.load_state_dict(load_file(CLIP_FILE), strict=False)
    # CLIP is small (~0.5 GB) — keep on CUDA so the pipeline's _execution_device resolves to CUDA
    text_encoder = text_encoder.to(dtype).to('cuda')

    log('STATUS:Loading T5 text encoder (CPU)...')
    t5_cfg          = T5Config.from_pretrained(os.path.join(hf_cache, 'text_encoder_2'))
    text_encoder_2  = T5EncoderModel(t5_cfg)
    text_encoder_2.load_state_dict(load_file(T5_FILE), strict=False)
    # T5 stays on CPU to save ~4 GB of VRAM for the transformer.
    # Register a pre-hook that moves any CUDA inputs back to CPU so the
    # pipeline's .to(execution_device) call doesn't cause a device mismatch.
    text_encoder_2  = text_encoder_2.to(dtype)
    def _cpu_input_hook(module, args, kwargs):
        args = tuple(x.cpu() if isinstance(x, torch.Tensor) else x for x in args)
        kwargs = {k: v.cpu() if isinstance(v, torch.Tensor) else v for k, v in kwargs.items()}
        return args, kwargs
    text_encoder_2.register_forward_pre_hook(_cpu_input_hook, with_kwargs=True)

    log('STATUS:Loading VAE...')
    vae = AutoencoderKL.from_single_file(
        VAE_FILE, config=hf_cache, subfolder='vae', torch_dtype=dtype
    ).to('cuda')

    log(f'STATUS:Loading Flux transformer ({flux_key})...')
    transformer = FluxTransformer2DModel.from_single_file(
        FLUX_FILES[flux_key], torch_dtype=dtype
    ).to('cuda')

    log('STATUS:Assembling pipeline...')
    pipe = FluxPipeline(
        scheduler=scheduler,
        text_encoder=text_encoder,
        tokenizer=tokenizer,
        text_encoder_2=text_encoder_2,
        tokenizer_2=tokenizer_2,
        vae=vae,
        transformer=transformer,
    )
    # Reduces activation peak memory so the 22GB transformer has breathing room
    pipe.enable_attention_slicing()
    return pipe


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--model',          default='schnell')
    p.add_argument('--prompt',         required=True)
    p.add_argument('--negative-prompt', default='')
    p.add_argument('--height',         type=int, default=1024)
    p.add_argument('--width',          type=int, default=1024)
    p.add_argument('--steps',          type=int, default=4)
    p.add_argument('--seed',           type=int, default=None)
    p.add_argument('--guidance',       type=float, default=0.0)
    p.add_argument('--quantize',       type=int, default=8)   # ignored on Windows
    p.add_argument('--output',         required=True)
    p.add_argument('--metadata',       action='store_true')
    p.add_argument('--lora-paths',     nargs='*', default=[])
    p.add_argument('--lora-scales',    nargs='*', type=float, default=[])
    args = p.parse_args()

    flux_key = MODEL_ID_MAP.get(args.model, 'schnell')
    dtype    = torch.bfloat16

    hf_cache = find_flux_hf_cache()
    if not hf_cache:
        log('ERROR: Flux config cache not found. Run the app Settings page first.')
        sys.exit(1)

    for label, path in [('Flux model', FLUX_FILES[flux_key]), ('VAE', VAE_FILE),
                         ('CLIP', CLIP_FILE), ('T5', T5_FILE)]:
        if not os.path.exists(path):
            log(f'ERROR: {label} file not found: {path}')
            sys.exit(1)

    generator = torch.Generator('cuda').manual_seed(args.seed) if args.seed is not None else None

    pipe = build_pipeline(flux_key, hf_cache, dtype)

    log(f'STATUS:Generating image ({args.width}x{args.height}, {args.steps} steps)...')

    result = pipe(
        prompt=args.prompt,
        negative_prompt=args.negative_prompt or None,
        height=args.height,
        width=args.width,
        num_inference_steps=args.steps,
        guidance_scale=args.guidance if args.guidance > 0 else 0.0,
        generator=generator,
        callback_on_step_end=progress_callback,
        callback_on_step_end_tensor_inputs=['latents'],
    )

    image = result.images[0]
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    image.save(args.output)
    log(f'STATUS:Saved to {args.output}')

    if args.metadata:
        meta = {
            'model': args.model,
            'prompt': args.prompt,
            'negative_prompt': args.negative_prompt,
            'height': args.height,
            'width': args.width,
            'steps': args.steps,
            'seed': args.seed,
            'guidance': args.guidance,
        }
        meta_path = args.output.replace('.png', '.metadata.json')
        with open(meta_path, 'w') as f:
            json.dump(meta, f, indent=2)

    log('STATUS:Done')


if __name__ == '__main__':
    main()
