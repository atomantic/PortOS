#!/usr/bin/env python3
"""Use one checkpoint-defined ladder for FastH3 conversion and inference.

The pinned upstream converter defaults to four steps and strips the original
AdaLN projections. Build the correct fixed tables before they are stripped;
the inference pipeline must then use exactly the same shifts and steps.
All adaptation is process-local, leaving the upstream checkout untouched.
"""
import argparse
import importlib.util
import importlib
import json
import math
import runpy
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--entry-script', required=True)
    parser.add_argument('--scheduler-root', required=True)
    parser.add_argument('--schedule-steps', type=int, required=True)
    parser.add_argument('--convert', action='store_true')
    args, remaining = parser.parse_known_args()
    if args.schedule_steps <= 0:
        raise ValueError('FastH3 schedule steps must be positive')
    shifts = []
    for name in ('scheduler', 'audio_scheduler'):
        config = json.loads((Path(args.scheduler_root) / name / 'scheduler_config.json').read_text())
        shift = config.get('shift')
        if (config.get('_class_name') != 'MiniMaxH3Scheduler'
                or isinstance(shift, bool) or not isinstance(shift, (int, float))
                or not math.isfinite(shift) or shift <= 0):
            raise ValueError(f'Unsupported FastH3 {name} configuration')
        shifts.append(shift)
    contract = json.loads((Path(args.scheduler_root) / 'fastvideo_inference.json').read_text())
    rungs = contract.get('dmd_denoising_steps')
    if (contract.get('schema_version') != 'fasth3-inference-contract-v1'
            or not isinstance(rungs, list) or len(rungs) != args.schedule_steps
            or any(type(rung) is not int or not 0 < rung <= 1000 for rung in rungs)
            or any(left <= right for left, right in zip(rungs, rungs[1:]))
            or contract.get('video_scheduler_shift') != shifts[0]
            or contract.get('audio_scheduler_shift') != shifts[1]):
        raise ValueError('Unsupported FastH3 checkpoint inference contract')
    from fastvideo.mlx_runtime import minimax_h3_pipeline as pipeline
    # Both modules expose the scheduler shifts, and the converter imports the
    # values from ``minimax_h3`` while the inference pipeline reads its own
    # module globals.  Updating only the pipeline (the old behavior) leaves
    # conversion and inference using different schedules, which produces a
    # VSA checkpoint that fails during the first render. Keep the two module
    # views synchronized before either entry point is loaded.
    h3 = importlib.import_module('fastvideo.mlx_runtime.minimax_h3')
    h3.MINIMAX_H3_VIDEO_SHIFT, h3.MINIMAX_H3_AUDIO_SHIFT = shifts
    # The upstream MLX scheduler uses a uniform linspace. V2's trained ladder
    # differs (999, 874, ...), so patch the function used by SchedulerState
    # before loading either entry point. Shift the shared noise clock once.
    def checkpoint_sigmas(shift, num_denoise_steps):
        if num_denoise_steps != len(rungs):
            raise ValueError('FastH3 step count differs from its trained ladder')
        base = [rung / 1000.0 for rung in rungs] + [0.0]
        return h3.np.asarray([shift * value / (1.0 + (shift - 1.0) * value)
                              for value in base], dtype=h3.np.float32)
    h3.minimax_h3_sigmas = checkpoint_sigmas
    pipeline.MINIMAX_H3_VIDEO_SHIFT, pipeline.MINIMAX_H3_AUDIO_SHIFT = shifts
    sys.argv = [args.entry_script, *remaining]
    if args.convert:
        spec = importlib.util.spec_from_file_location('portos_h3_converter', args.entry_script)
        converter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(converter)
        if not callable(getattr(converter, '_adaln_cache_timesteps', None)):
            raise RuntimeError('FastH3 converter schedule contract changed; update PortOS')
        converter._adaln_cache_timesteps = lambda: pipeline._adaln_schedule_union(args.schedule_steps)
        converter.main()
    else:
        runpy.run_path(args.entry_script, run_name='__main__')


if __name__ == '__main__':
    main()
