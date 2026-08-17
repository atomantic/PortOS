#!/usr/bin/env python3
"""MiniMax Music 3 Diffusers sidecar using PortOS' STAGE/RESULT protocol."""
import argparse
import inspect
import json
import os
import sys
import time
import wave

from _runner_common import choose_cuda_pipeline_placement


FULL_CUDA_PROFILE = 'cuda-bf16-full'
OFFLOAD_CUDA_PROFILE = 'cuda-bf16-component-offload'
AUTOREGRESSIVE_COMPONENTS = frozenset({'language_model', 'rvq_depth_decoder'})


def managed_component_name(model_id):
    """Remove ComponentsManager's runtime object-id suffix from a hook id."""
    name, separator, suffix = model_id.rpartition('_')
    return name if separator and suffix.isdigit() else model_id


def minimax_offload_strategy(hooks, model_id, model, execution_device):
    """Keep MiniMax's mandatory autoregressive pair resident together.

    Diffusers invokes the language model and RVQ decoder together for every
    generated frame. Its generic size-based strategy can evict the first while
    loading the second. For those two incoming components, evict only unrelated
    phases; for every other phase, evict all resident managed components.
    """
    del model, execution_device
    if managed_component_name(model_id) in AUTOREGRESSIVE_COMPONENTS:
        return [
            hook for hook in hooks
            if managed_component_name(hook.model_id) not in AUTOREGRESSIVE_COMPONENTS
        ]
    return hooks


def place_minimax_pipeline(pipe, components_manager, torch):
    """Apply MiniMax's experimental CUDA placement and return its effective profile."""
    placement = choose_cuda_pipeline_placement(
        pipe,
        torch,
        override_env='PORTOS_MINIMAX_MUSIC3_OFFLOAD',
        # MiniMax keeps full CUDA residency whenever weights plus the shared
        # activation reserve fit. Unlike image pipelines, there is no separate
        # proportional trigger while this profile remains experimental.
        offload_vram_fraction=None,
        log_label='minimax-music3',
    )
    if placement['use_offload']:
        enable_offload = getattr(components_manager, 'enable_auto_cpu_offload', None)
        if not callable(enable_offload):
            raise RuntimeError(
                'MiniMax Music 3 selected component offload, but this Diffusers runtime '
                'does not expose ComponentsManager.enable_auto_cpu_offload()'
            )
        # The ComponentsManager API documents workflow-specific strategy
        # callables for component sets whose co-residency requirements cannot
        # be inferred from individual weight footprints.
        enable_offload(device='cuda', offload_strategy=minimax_offload_strategy)
        return OFFLOAD_CUDA_PROFILE
    pipe.to('cuda')
    return FULL_CUDA_PROFILE


def to_numpy(audio, np, torch):
    """Diffusers hands back either a torch tensor or an ndarray depending on version."""
    while isinstance(audio, (list, tuple)):
        audio = audio[0]
    if isinstance(audio, torch.Tensor):
        return audio.detach().float().cpu().numpy()
    return np.asarray(audio)


def to_stereo(audio, np):
    """Orient a decoded waveform to (2, samples) float32 whichever layout it arrives in."""
    audio = np.squeeze(audio).astype(np.float32)
    if audio.ndim == 1:
        return np.stack([audio, audio])
    if audio.ndim != 2:
        raise RuntimeError(f'unexpected audio shape {audio.shape}')
    if audio.shape[0] == 2:
        return audio
    # Channels-last (samples, 2), or a lone channel row - orient to (2, samples).
    return audio.T if audio.shape[1] == 2 else np.stack([audio[0], audio[0]])


def seeded_generation_kwargs(pipe, torch, seed):
    """Return a CUDA generator only when this Diffusers pipeline accepts one."""
    if seed is None:
        return {}
    try:
        parameters = inspect.signature(pipe.__call__).parameters
    except (TypeError, ValueError):
        return {}
    accepts_generator = 'generator' in parameters or any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters.values()
    )
    if not accepts_generator:
        return {}
    return {'generator': torch.Generator(device='cuda').manual_seed(int(seed))}


def main():
    started_at = time.perf_counter()
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--text', required=True)
    parser.add_argument('--lyrics', default='')
    parser.add_argument('--duration', type=float, required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--runtime-dir', default='')
    # This is intentionally a sidecar-only benchmark hook. The production
    # server does not pass it, so normal user renders retain the model's
    # default sampling behavior.
    parser.add_argument('--seed', type=int, default=None)
    args = parser.parse_args()
    if args.runtime_dir:
        sys.path.insert(0, args.runtime_dir)

    import numpy as np
    import torch
    from diffusers import ModularPipeline
    from diffusers.modular_pipelines import ComponentsManager

    if not torch.cuda.is_available():
        raise RuntimeError('MiniMax Music 3 requires CUDA')
    print('STAGE:load-model', file=sys.stderr, flush=True)
    components_manager = ComponentsManager()
    pipe = ModularPipeline.from_pretrained(args.model, components_manager=components_manager)
    pipe.load_components(dtype=torch.bfloat16)
    execution_profile = place_minimax_pipeline(pipe, components_manager, torch)
    print('STAGE:generate', file=sys.stderr, flush=True)
    torch.cuda.reset_peak_memory_stats()
    generation_kwargs = seeded_generation_kwargs(pipe, torch, args.seed)
    if args.seed is not None and not generation_kwargs:
        raise RuntimeError('this Diffusers pipeline does not support deterministic --seed generation')
    audio = to_numpy(pipe(
        prompt=args.text,
        lyrics=args.lyrics,
        audio_duration=float(max(1, min(300, args.duration))),
        output='audios',
        **generation_kwargs,
    )[0], np, torch)
    audio = to_stereo(audio, np)
    torch.cuda.synchronize()
    peak_vram_allocated_gb = torch.cuda.max_memory_allocated() / (1024 ** 3)
    peak_vram_reserved_gb = torch.cuda.max_memory_reserved() / (1024 ** 3)
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
    print('RESULT:' + json.dumps({
        'durationSec': len(pcm) / 32000,
        'executionProfile': execution_profile,
        # Reserved is the conservative device-memory bound; allocated remains
        # useful for distinguishing model/activation use from allocator cache.
        'peakVramGb': round(peak_vram_reserved_gb, 3),
        'peakVramAllocatedGb': round(peak_vram_allocated_gb, 3),
        'totalTimeSec': round(time.perf_counter() - started_at, 3),
        **({'seed': args.seed, 'seedApplied': True} if args.seed is not None else {}),
    }), flush=True)


if __name__ == '__main__':
    main()
