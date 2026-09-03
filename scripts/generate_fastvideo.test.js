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

// Phase reporting (#5872). FastH3's MLX pipeline logs one milestone line per
// phase and NO per-step denoise progress, so these markers plus the heartbeat
// are the only thing standing between the user and a 20-minute blank 0%.
describe.skipIf(!pyBin)('generate_fastvideo.py phase reporting', () => {
  it('advances the phase on each upstream milestone line', () => {
    const output = runPython(`${importRunner}\n${[
      'phase = runner.INITIAL_PHASE',
      'for line in [',
      '    "INFO Geometry: output=832x480x124 model=832x480x124 audio_frames=124 fast=None",',
      '    "INFO Loaded prompt embeddings from cache abc123",',
      '    "INFO Loaded MLX H3 DiT from /models/int4 in 412.7s",',
      '    "INFO Generation complete: /out/render.mp4 | timings={} peaks={}",',
      ']:',
      '    phase = runner.advance_phase(line, phase)',
      '    print(phase)',
    ].join('\n')}`);

    // 'conditioning', deliberately NOT 'encode-prompt' — that exact marker is
    // generate_ltx2.py's prompt-encode BEGIN sentinel, and emitting it here
    // would arm an ltx2-only relaunch against a FastVideo render.
    expect(lines(output)).toEqual(['conditioning', 'sampling', 'sampling', 'mux']);
  });

  it('never moves the phase backwards when a milestone line repeats', () => {
    const output = runPython(`${importRunner}\n${[
      'print(runner.advance_phase("INFO Geometry: output=832x480x124", "sampling"))',
      'print(runner.advance_phase("nothing to see here", "sampling"))',
    ].join('\n')}`);

    expect(lines(output)).toEqual(['sampling', 'sampling']);
  });

  // fastmetal reports denoise steps but none of FastH3's milestone wording, so
  // without this its heartbeat would keep claiming "Loading the FastVideo
  // pipeline" while the step counter climbed.
  it('treats a denoising step as proof the sampler is running', () => {
    const output = runPython(`${importRunner}\n${[
      'print(runner.advance_phase("denoising step 2/4", runner.INITIAL_PHASE))',
    ].join('\n')}`);

    expect(lines(output)).toEqual(['sampling']);
  });

  it('labels every phase it can advance into', () => {
    const output = runPython(`${importRunner}\n${[
      'print(sorted(runner._PHASE_ORDER) == sorted(runner.PHASE_LABELS))',
    ].join('\n')}`);

    expect(lines(output)).toEqual(['True']);
  });
});
