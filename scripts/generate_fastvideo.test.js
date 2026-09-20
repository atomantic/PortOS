import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';
import { createVideoDiagnosticTail } from '../server/lib/videoFailure.js';

const script = join(dirname(fileURLToPath(import.meta.url)), 'generate_fastvideo.py');
const pyBin = resolveTestPython();
const runPython = (source) => execFileSync(pyBin, ['-c', source, script], {
  encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});
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
  it.each(['ValueError: loading converted tensors failed', 'kIOGPUCommandBufferCallbackErrorTimeout', null])('preserves converter cause evidence (%s) without inventing it from an exit code', (cause) => {
    const output = runPython(`${importRunner}\n${[
      'import tempfile',
      'from contextlib import redirect_stderr',
      'from unittest.mock import patch',
      'with tempfile.TemporaryDirectory() as tmp:',
      '    root = Path(tmp)',
      '    (root / "model" / "transformer").mkdir(parents=True)',
      '    converter = root.joinpath(*runner._CONVERTER_SCRIPT)',
      '    converter.parent.mkdir(parents=True)',
      '    converter.touch()',
      '    with patch.object(runner.subprocess, "Popen") as spawn, redirect_stderr(sys.stdout):',
      `        spawn.return_value.stdout = ${JSON.stringify(['Loading weights', ...(cause ? [cause] : [])])}`,
      '        spawn.return_value.wait.return_value = 1',
      '        try:',
      '            runner.ensure_mlx_checkpoint(root, root / "model", "int4", {}, root / "cache")',
      '        except RuntimeError as error:',
      '            print(f"❌ {error}")',
    ].join('\n')}`);
    expect(output).toContain('STATUS:Loading weights');
    const tail = createVideoDiagnosticTail();
    tail.push('stderr', output);
    if (cause?.startsWith('kIOGPU')) expect(tail.failure()).toMatchObject({ classification: 'metal-command-buffer', cause: 'Metal command buffer failed: Timeout' });
    else if (cause) expect(tail.failure()).toMatchObject({ classification: 'valueerror', cause: 'loading converted tensors failed' });
    else expect(tail.failure()).toBeNull();
  });

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

  it('reports Wan 2.2 conditioning, sampling and decode from its milestone output', () => {
    const output = runPython(`${importRunner}\n${[
      'phase = runner.INITIAL_PHASE',
      'for line in ["[5B] latent 48x19x16x24", "[5B] DiT loaded in 1.0s", "[5B] denoise 3 steps in 19.0s, peak 7.3 GiB"]:',
      '    phase = runner.advance_phase(line, phase)',
      '    print(phase)',
    ].join('\n')}`);
    expect(lines(output)).toEqual(['conditioning', 'sampling', 'mux']);
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

// Exercise the subprocess boundary without requiring MLX or model weights.
describe.skipIf(!pyBin)('FastH3 checkpoint schedule adapter', () => {
  it('uses the same checkpoint shifts and eight-step ladder for conversion and inference', () => {
    const output = runPython(`${importRunner}\n${String.raw`
import json, os, subprocess, tempfile
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    package = root / 'fastvideo' / 'mlx_runtime'
    package.mkdir(parents=True)
    (package / 'minimax_h3.py').write_text('from types import SimpleNamespace\nnp=SimpleNamespace(asarray=lambda values, dtype: values, float32=float)\n')
    (package / 'minimax_h3_pipeline.py').write_text('from . import minimax_h3 as h3\nMINIMAX_H3_VIDEO_SHIFT=12\nMINIMAX_H3_AUDIO_SHIFT=3\ndef _adaln_schedule_union(steps):\n    return [h3.minimax_h3_sigmas(shift, steps) for shift in (MINIMAX_H3_VIDEO_SHIFT, MINIMAX_H3_AUDIO_SHIFT)]\n')
    (root / 'fastvideo_inference.json').write_text(json.dumps({'schema_version': 'fasth3-inference-contract-v1', 'dmd_denoising_steps': [999,874,749,624,500,375,250,125], 'video_scheduler_shift': 10, 'audio_scheduler_shift': 3}))
    for name, shift in [('scheduler', 10), ('audio_scheduler', 3)]:
        folder = root / name
        folder.mkdir()
        (folder / 'scheduler_config.json').write_text(json.dumps({'_class_name': 'MiniMaxH3Scheduler', 'shift': shift}))
    converter = root / 'convert.py'
    converter.write_text('import json\ndef _adaln_cache_timesteps():\n    return [12, 3, 4]\ndef main():\n    print(json.dumps(_adaln_cache_timesteps()))\n')
    entry = root / 'render.py'
    entry.write_text('import json, sys\nfrom fastvideo.mlx_runtime import minimax_h3_pipeline as p\nprint(json.dumps(p._adaln_schedule_union(int(sys.argv[sys.argv.index("--steps")+1]))))\n')
    wrapper = script.with_name('fastvideo_h3_entry.py')
    env = {**os.environ, 'PYTHONPATH': str(root)}
    base = [sys.executable, str(wrapper), '--scheduler-root', str(root), '--schedule-steps', '8']
    for target, tail in [(converter, ['--convert']), (entry, ['--steps', '8'])]:
        print(subprocess.check_output(base + ['--entry-script', str(target)] + tail, env=env, text=True).strip())
    contract = root / 'fastvideo_inference.json'
    value = json.loads(contract.read_text())
    value['dmd_denoising_steps'][1] = 999
    contract.write_text(json.dumps(value))
    invalid_contract = subprocess.run(base + ['--entry-script', str(entry), '--steps', '8'], env=env, text=True, capture_output=True)
    print(invalid_contract.returncode != 0 and not invalid_contract.stdout and 'inference contract' in invalid_contract.stderr)
    (root / 'scheduler' / 'scheduler_config.json').write_text('{"_class_name":"MiniMaxH3Scheduler","shift":true}')
    invalid = subprocess.run(base + ['--entry-script', str(entry), '--steps', '8'], env=env, text=True, capture_output=True)
    print(invalid.returncode != 0 and not invalid.stdout and 'Unsupported FastH3 scheduler' in invalid.stderr)
`}`);
    const [conversion, inference, invalidContract, invalid] = lines(output);
    const expected = [10, 3].map((shift) => [999, 874, 749, 624, 500, 375, 250, 125, 0]
      .map((rung) => shift * (rung / 1000) / (1 + (shift - 1) * (rung / 1000))));
    expect(JSON.parse(conversion)).toEqual(expected);
    expect(JSON.parse(inference)).toEqual(expected);
    expect(invalidContract).toBe('True');
    expect(invalid).toBe('True');
  });
});
