#!/usr/bin/env python3
"""Use one checkpoint-defined ladder for FastH3 conversion and inference.

The pinned upstream converter defaults to four steps and strips the original
AdaLN projections. Build the correct fixed tables before they are stripped;
the inference pipeline must then use exactly the same shifts and steps.
All adaptation is process-local, leaving the upstream checkout untouched.
"""
import argparse
import importlib.util
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
    from fastvideo.mlx_runtime import minimax_h3 as h3
    from fastvideo.mlx_runtime import minimax_h3_pipeline as pipeline
    # Both modules expose the scheduler shifts, and the converter imports the
    # values from ``minimax_h3`` while the inference pipeline reads its own
    # module globals.  Updating only the pipeline (the old behavior) leaves
    # conversion and inference using different schedules, which produces a
    # VSA checkpoint that fails during the first render. Keep the two module
    # views synchronized before either entry point is loaded.
    h3.MINIMAX_H3_VIDEO_SHIFT, h3.MINIMAX_H3_AUDIO_SHIFT = shifts
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
