#!/usr/bin/env python3
"""MiniMax Music 3 Diffusers sidecar using PortOS' STAGE/RESULT protocol."""
import argparse
import json
import os
import sys
import wave


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--text', required=True)
    parser.add_argument('--lyrics', default='')
    parser.add_argument('--duration', type=float, required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--runtime-dir', default='')
    args = parser.parse_args()
    if args.runtime_dir:
        sys.path.insert(0, args.runtime_dir)

    import numpy as np
    import torch
    from diffusers import ModularPipeline

    if not torch.cuda.is_available():
        raise RuntimeError('MiniMax Music 3 requires CUDA')
    print('STAGE:load-model', file=sys.stderr, flush=True)
    pipe = ModularPipeline.from_pretrained(args.model)
    pipe.load_components(dtype=torch.bfloat16)
    pipe.to('cuda')
    print('STAGE:generate', file=sys.stderr, flush=True)
    audio = pipe(
        prompt=args.text,
        lyrics=args.lyrics,
        audio_duration=float(max(1, min(300, args.duration))),
        output='audios',
    )[0].float().cpu().numpy()
    if audio.ndim == 1:
        audio = np.stack([audio, audio])
    if audio.shape[0] != 2:
        audio = audio.T
    source_rate = int(pipe.sampling_rate)
    if source_rate != 32000:
        source_x = np.arange(audio.shape[1], dtype=np.float64)
        target_x = np.linspace(0, audio.shape[1] - 1, round(audio.shape[1] * 32000 / source_rate))
        audio = np.stack([np.interp(target_x, source_x, channel) for channel in audio])
    pcm = np.clip(audio, -1, 1)
    pcm = (pcm.T * 32767).astype(np.int16)
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with wave.open(args.output, 'wb') as wav:
        wav.setnchannels(2); wav.setsampwidth(2); wav.setframerate(32000); wav.writeframes(pcm.tobytes())
    print('RESULT:' + json.dumps({'durationSec': len(pcm) / 32000}), flush=True)


if __name__ == '__main__':
    main()
