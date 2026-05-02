"""
Windows video generation backend using diffusers + LTX-Video-0.9.5.
Supports both text-to-video (T2V) and image-to-video (I2V).
Accepts the same-style CLI args as imagine_win.py; generate.js dispatches here on win32.
"""
import argparse
import os
import sys
import warnings

warnings.filterwarnings('ignore')
os.environ['XFORMERS_DISABLED'] = '1'
os.environ['PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION'] = 'python'

import torch
import numpy as np
import cv2
from PIL import Image

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def log(msg):
    print(msg, file=sys.stderr, flush=True)


def progress_callback(pipe, step, timestep, callback_kwargs):
    total = pipe._num_timesteps
    pct = int((step + 1) / total * 100)
    bar = '█' * (pct // 5) + '▒' * (20 - pct // 5)
    log(f'{pct}%|{bar}| {step + 1}/{total}')
    return callback_kwargs


def save_video(frames, path, fps):
    """Save a list of PIL images as an MP4 using cv2 (always available)."""
    if not frames:
        raise RuntimeError('No frames to save')
    w, h = frames[0].size
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(path, fourcc, float(fps), (w, h))
    if not writer.isOpened():
        raise RuntimeError(f'cv2.VideoWriter failed to open: {path}')
    for frame in frames:
        arr = np.array(frame.convert('RGB'))
        writer.write(arr[:, :, ::-1])  # RGB → BGR
    writer.release()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

LTX_MODEL_ID = 'Lightricks/LTX-Video-0.9.5-dev'

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--model',          default='ltx_video')
    p.add_argument('--prompt',         required=True)
    p.add_argument('--negative-prompt', default='worst quality, inconsistent motion, blurry, jittery, distorted')
    p.add_argument('--height',         type=int, default=512)
    p.add_argument('--width',          type=int, default=768)
    p.add_argument('--num-frames',     type=int, default=121)
    p.add_argument('--fps',            type=int, default=24)
    p.add_argument('--steps',          type=int, default=25)
    p.add_argument('--guidance',       type=float, default=3.0)
    p.add_argument('--seed',           type=int, default=None)
    p.add_argument('--output',         required=True)
    p.add_argument('--image',          default=None)
    p.add_argument('--last-image',     default=None,
                   help='Optional end-frame target (FFLF). Currently advisory — '
                        'LTX-Video 0.9.5 diffusers pipeline does not natively '
                        'consume two keyframes; flag is accepted for forward '
                        'compatibility with multi-keyframe pipelines.')
    args = p.parse_args()
    # The current LTX-Video 0.9.5 diffusers pipelines only accept a single
    # conditioning image, so --last-image is forward-compat only. Tailor the
    # STATUS log to the actual branch the script will take based on whether
    # --image was also provided, so users/logs aren't misled into thinking we
    # ran an I2V flow when we're really running T2V.
    #
    # STATUS lines are forwarded over SSE to the browser, so log just the
    # basename rather than the absolute server path to avoid leaking
    # filesystem layout to the client.
    if args.last_image:
        last_image_name = os.path.basename(args.last_image)
        if args.image:
            log(
                f'STATUS:Last-frame image supplied ({last_image_name}) — '
                'currently advisory; using single-image I2V with --image as '
                'the only conditioning frame'
            )
        else:
            log(
                f'STATUS:Last-frame image supplied ({last_image_name}) without --image — '
                'currently advisory and ignored for mode selection; continuing with T2V'
            )

    dtype = torch.bfloat16
    generator = torch.Generator('cuda').manual_seed(args.seed) if args.seed is not None else None

    os.makedirs(os.path.dirname(args.output), exist_ok=True)

    # LTX-Video requires num_frames == 8k + 1
    num_frames = args.num_frames
    if (num_frames - 1) % 8 != 0:
        num_frames = ((num_frames - 1) // 8) * 8 + 1
        log(f'STATUS:Adjusted frames to {num_frames} (LTX requires 8k+1)')

    neg = args.negative_prompt or 'worst quality, inconsistent motion, blurry, jittery, distorted'

    if args.image:
        from diffusers import LTXImageToVideoPipeline
        log('STATUS:Loading LTX-Video image-to-video pipeline...')
        log('STATUS:(First run auto-downloads ~9.5 GB — subsequent runs use cache)')
        pipe = LTXImageToVideoPipeline.from_pretrained(LTX_MODEL_ID, torch_dtype=dtype)
        pipe = pipe.to('cuda')
        pipe.enable_vae_tiling()

        src = Image.open(args.image).convert('RGB').resize(
            (args.width, args.height), Image.LANCZOS
        )
        log(f'STATUS:Generating video from image ({args.width}x{args.height}, {num_frames} frames, {args.steps} steps)...')
        result = pipe(
            image=src,
            prompt=args.prompt,
            negative_prompt=neg,
            height=args.height,
            width=args.width,
            num_frames=num_frames,
            num_inference_steps=args.steps,
            guidance_scale=args.guidance,
            decode_timestep=0.05,
            decode_noise_scale=0.025,
            generator=generator,
            callback_on_step_end=progress_callback,
            callback_on_step_end_tensor_inputs=['latents'],
        )
    else:
        from diffusers import LTXPipeline
        log('STATUS:Loading LTX-Video text-to-video pipeline...')
        log('STATUS:(First run auto-downloads ~9.5 GB — subsequent runs use cache)')
        pipe = LTXPipeline.from_pretrained(LTX_MODEL_ID, torch_dtype=dtype)
        pipe = pipe.to('cuda')
        pipe.enable_vae_tiling()

        log(f'STATUS:Generating video ({args.width}x{args.height}, {num_frames} frames, {args.steps} steps)...')
        result = pipe(
            prompt=args.prompt,
            negative_prompt=neg,
            height=args.height,
            width=args.width,
            num_frames=num_frames,
            num_inference_steps=args.steps,
            guidance_scale=args.guidance,
            decode_timestep=0.05,
            decode_noise_scale=0.025,
            generator=generator,
            callback_on_step_end=progress_callback,
            callback_on_step_end_tensor_inputs=['latents'],
        )

    log('STATUS:Saving video...')
    save_video(result.frames[0], args.output, args.fps)
    # Log only the basename — STATUS lines are forwarded over SSE to the
    # browser, and emitting the absolute server path would leak filesystem
    # layout. The Node side already knows the full path from the --output arg.
    log(f'STATUS:Saved to {os.path.basename(args.output)}')
    log('STATUS:Done')


if __name__ == '__main__':
    main()
