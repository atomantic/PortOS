import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const script = join(dirname(fileURLToPath(import.meta.url)), 'generate_minimax_music3_mlx.py');
const pyBin = resolveTestPython();
const hasNumpy = (() => {
  if (!pyBin) return false;
  try {
    execFileSync(pyBin, ['-c', 'import numpy'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const runPython = (body) => execFileSync(pyBin, ['-c', [
  'import importlib.util, json, sys',
  'import numpy as np',
  'spec = importlib.util.spec_from_file_location("mm3mlx", sys.argv[1])',
  'mod = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(mod)',
  body,
].join('\n'), script], { encoding: 'utf8' }).trim();

describe.skipIf(!hasNumpy)('generate_minimax_music3_mlx sidecar helpers', () => {
  it('orients channels-first, channels-last, and mono audio to stereo', () => {
    const output = runPython([
      'values = {}',
      'for label, shape in (("first", (2, 8)), ("last", (8, 2)), ("mono", (8,))):',
      '    values[label] = list(mod.to_stereo(np.arange(int(np.prod(shape)), dtype=np.float64).reshape(shape), np).shape)',
      'print(json.dumps(values))',
    ].join('\n'));
    expect(JSON.parse(output)).toEqual({ first: [2, 8], last: [2, 8], mono: [2, 8] });
  });

  it('resamples the MLX 44.1 kHz output to the shared 32 kHz library rate', () => {
    const output = runPython([
      'audio = np.zeros((2, 441), dtype=np.float32)',
      'resampled = mod.resample_to_target(audio, 44100, np)',
      'print(json.dumps(list(resampled.shape)))',
    ].join('\n'));
    expect(JSON.parse(output)).toEqual([2, 320]);
  });

  it('rejects an audio shape that cannot be made stereo', () => {
    expect(() => runPython('mod.to_stereo(np.zeros((3, 4), dtype=np.float32), np)')).toThrow();
  });
});
