import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const script = join(dirname(fileURLToPath(import.meta.url)), 'generate_fastvideo.py');
const pyBin = resolveTestPython();
const runPython = (source) => execFileSync(pyBin, ['-c', source, script], { encoding: 'utf8' });
const lines = (output) => output.trim().split('\n').map((line) => line.trimEnd());

const importRunner = [
  'import importlib.util, sys',
  'from pathlib import Path',
  'script = Path(sys.argv[1])',
  'spec = importlib.util.spec_from_file_location("generate_fastvideo", script)',
  'runner = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(runner)',
].join('\n');

describe.skipIf(!pyBin)('generate_fastvideo.py', () => {
  it('reports only denoising steps as render progress', () => {
    const output = runPython(`${importRunner}\n${[
      'print(runner.translate_line("Loading checkpoint: 100%|##########| 10/10"))',
      'print(runner.translate_line("denoise step 1/3 complete"))',
      'print(runner.translate_line("denoising step 3 / 3 complete"))',
    ].join('\n')}`);

    expect(lines(output)).toEqual([
      'STATUS:FastVideo: Loading checkpoint: 100%|##########| 10/10',
      'STAGE:fastvideo:step:1:3:denoising step 1/3',
      'STAGE:fastvideo:step:3:3:denoising step 3/3',
    ]);
  });

  it('does not treat an unrelated step or percentage as render completion', () => {
    const output = runPython(`${importRunner}\n${[
      'print(runner.translate_line("Loading pipeline step 3/3"))',
      'print(runner.translate_line("100%|##########| 1/1"))',
    ].join('\n')}`);

    expect(lines(output)).toEqual([
      'STATUS:Loading pipeline step 3/3',
      'STATUS:FastVideo: 100%|##########| 1/1',
    ]);
  });
});
