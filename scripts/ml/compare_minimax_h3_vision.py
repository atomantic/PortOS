#!/usr/bin/env python3
"""Compare synthetic H3 vision traces; report observations, never a passing tolerance."""
import argparse
import json
from pathlib import Path


def compare(actual, reference):
    import numpy as np
    manifests = [json.loads((p / 'manifest.json').read_text()) for p in (actual, reference)]
    for key in ('pixel_sha256', 'grid_thw', 'vision_config_sha256', 'vision_weights_sha256'):
        if manifests[0][key] != manifests[1][key]:
            raise ValueError(f'Cannot compare different inputs: {key}')
    for manifest in manifests:
        stages = manifest['stages']
        if (not stages or len({s['name'] for s in stages}) != len(stages)
                or not any(s['name'] == 'merged' for s in stages)):
            raise ValueError('Incomplete or duplicate trace stages')
    names = [{s['name'] for s in m['stages'] if not s['name'].startswith('replay_')} for m in manifests]
    if names[0] != names[1]:
        raise ValueError('Trace stages differ; rerun both with the same diagnostic')
    results = []
    for stage in manifests[0]['stages']:
        name = stage['name']
        reference_name = name.removeprefix('replay_')
        # Only our flat filenames are accepted, never arbitrary manifest paths.
        if not name.replace('_', '').isalnum() or not reference_name:
            raise ValueError('Invalid stage name')
        a, b = [np.load(p / f'{n}.npy', allow_pickle=False).astype(np.float64)
                for p, n in ((actual, name), (reference, reference_name))]
        if a.shape != b.shape or a.size == 0 or not (np.isfinite(a).all() and np.isfinite(b).all()):
            raise ValueError(f'Invalid arrays at {name}')
        delta = a - b
        denominator = float(np.linalg.norm(b))
        results.append({
            'stage': name, 'shape': list(a.shape),
            'max_abs': float(np.max(np.abs(delta))),
            'rms': float(np.sqrt(np.mean(delta ** 2))),
            'reference_rms': float(np.sqrt(np.mean(b ** 2))),
            'relative_rms': float(np.linalg.norm(delta)) / denominator if denominator else None,
        })
    return {'actual': manifests[0], 'reference': manifests[1], 'stages': results}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('actual', type=Path)
    p.add_argument('reference', type=Path)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.output.exists():
        p.error('Output already exists; choose a new path')
    result = compare(a.actual, a.reference)
    with a.output.open('x') as f:
        json.dump(result, f, indent=2, allow_nan=False)
        f.write('\n')


if __name__ == '__main__':
    main()
