import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const python = resolveTestPython();
const script = fileURLToPath(new URL('./diagnose_minimax_h3_vision.py', import.meta.url));
const compare = fileURLToPath(new URL('./compare_minimax_h3_vision.py', import.meta.url));
const hasNumpy = python && spawnSync(python, ['-c', 'import numpy'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!python)('H3 vision diagnostic evidence boundary', () => {
  it('refuses existing evidence and invalid ablations before loading model dependencies', () => {
    const output = execFileSync(python, ['-c', `
import subprocess, sys, tempfile
from pathlib import Path
with tempfile.TemporaryDirectory() as root:
    output = Path(root) / 'result.npz'
    output.write_bytes(b'previous evidence')
    base = [sys.executable, sys.argv[1], 'torch', '--fixture', 'gradient-noise',
            '--checkpoint-dir', 'not-a-checkpoint', '--output', str(output)]
    for extra, message in [([], 'Output already exists'),
                           (['--position', 'float32'], 'ablations are MLX-only'),
                           (['--replay-dir', root], 'requires --trace-dir'),
                           (['--trace-dir', root], '--trace-dir must be new')]:
        result = subprocess.run(base + extra, capture_output=True, text=True)
        assert result.returncode != 0 and message in result.stderr, result.stderr
        assert output.read_bytes() == b'previous evidence'
print('ok')
`, script], { encoding: 'utf8' });
    expect(output).toContain('ok');
  });

  it.skipIf(!hasNumpy)('compares persisted traces directionally and rejects incompatible or invalid evidence', () => {
    const output = execFileSync(python, ['-c', `
import json, sys, tempfile, subprocess
from pathlib import Path
import numpy as np
with tempfile.TemporaryDirectory() as root:
    root = Path(root)
    actual, reference = root / 'a', root / 'b'
    manifest = {'pixel_sha256': 'synthetic-pixels', 'grid_thw': [[1, 2, 2]], 'vision_config_sha256': 'synthetic-config',
                'stages': [{'name': 'merged'}]}
    for directory, values in [(actual, [6., 8.]), (reference, [3., 4.])]:
        directory.mkdir()
        (directory / 'manifest.json').write_text(json.dumps(manifest))
        np.save(directory / 'merged.npy', values)
    def run(path):
        return subprocess.run([sys.executable, sys.argv[1], str(actual), str(reference),
                               '--output', str(path)], capture_output=True, text=True)
    target = root / 'comparison.json'
    assert run(target).returncode == 0
    result = json.loads(target.read_text())['stages'][0]
    assert result['relative_rms'] == 1.0 and result['max_abs'] == 4.0
    previous = target.read_bytes()
    assert run(target).returncode != 0 and target.read_bytes() == previous
    np.save(reference / 'merged.npy', [0., 0.])
    zero = root / 'zero.json'
    assert run(zero).returncode == 0
    assert json.loads(zero.read_text())['stages'][0]['relative_rms'] is None
    np.save(reference / 'merged.npy', [float('nan'), 4.])
    assert run(root / 'invalid.json').returncode != 0
    assert not (root / 'invalid.json').exists()
    manifest['pixel_sha256'] = 'different-pixels'
    (reference / 'manifest.json').write_text(json.dumps(manifest))
    assert run(root / 'mismatch.json').returncode != 0
    assert not (root / 'mismatch.json').exists()
print('ok')
`, compare], { encoding: 'utf8' });
    expect(output).toContain('ok');
  });
});
