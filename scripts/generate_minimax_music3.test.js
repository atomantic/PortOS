import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const script = join(dirname(fileURLToPath(import.meta.url)), 'generate_minimax_music3.py');

// Same probe as the other python-sidecar suites: on Windows a bare `python` is
// often a Store alias stub that exits non-zero, so pick an interpreter that
// actually runs and skip when there genuinely is none.
const pyBin = resolveTestPython();

// The sidecar's real numpy/torch imports live inside main(); to_numpy/to_stereo
// take them as parameters precisely so they can be exercised without the CUDA
// stack CI doesn't have. numpy is the one dep these cases need — torch is a
// two-line stand-in.
const hasNumpy = (() => {
  if (!pyBin) return false;
  try {
    execFileSync(pyBin, ['-c', 'import numpy'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const PRELUDE = [
  'import importlib.util, json, sys',
  'from pathlib import Path',
  'sys.path.insert(0, str(Path(sys.argv[1]).parent))',
  'import numpy as np',
  'spec = importlib.util.spec_from_file_location("mm3", sys.argv[1])',
  'mod = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(mod)',
  // Stands in for torch: a Tensor whose .float()/.cpu()/.detach() chain is the
  // path that must NOT run for an ndarray (the AttributeError this suite guards).
  'class Tensor:',
  '    def __init__(self, arr): self.arr = arr',
  '    def detach(self): return self',
  '    def float(self): return self',
  '    def cpu(self): return self',
  '    def numpy(self): return self.arr',
  'class torch: pass',
  'torch.Tensor = Tensor',
].join('\n');

const runPython = (body) => execFileSync(pyBin, ['-c', `${PRELUDE}\n${body}`, script], {
  encoding: 'utf8',
}).trim();
const runPythonWithoutNumpy = (body) => execFileSync(pyBin, ['-c', [
  'import importlib.util, json, sys',
  'from pathlib import Path',
  'sys.path.insert(0, str(Path(sys.argv[1]).parent))',
  'spec = importlib.util.spec_from_file_location("mm3", sys.argv[1])',
  'mod = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(mod)',
  body,
].join('\n'), script], { encoding: 'utf8' }).trim();

describe.skipIf(!hasNumpy)('generate_minimax_music3 sidecar helpers', () => {
  describe('to_numpy', () => {
    // Diffusers' MiniMax Music 3 decoder defaults to output_type="np", so the
    // pipeline hands back a plain ndarray — calling torch's .float().cpu() on it
    // raised AttributeError and killed every generation.
    it('passes an ndarray through untouched', () => {
      const out = runPython([
        'a = np.zeros((2, 8), dtype=np.float32)',
        'r = mod.to_numpy(a, np, torch)',
        'print(json.dumps([isinstance(r, np.ndarray), list(r.shape)]))',
      ].join('\n'));
      expect(JSON.parse(out)).toEqual([true, [2, 8]]);
    });

    it('unwraps a torch tensor via detach/float/cpu/numpy', () => {
      const out = runPython([
        'a = np.zeros((2, 8), dtype=np.float32)',
        'r = mod.to_numpy(Tensor(a), np, torch)',
        'print(json.dumps([isinstance(r, np.ndarray), list(r.shape)]))',
      ].join('\n'));
      expect(JSON.parse(out)).toEqual([true, [2, 8]]);
    });

    it('unwraps a list/tuple batch before converting', () => {
      const out = runPython([
        'a = np.zeros((2, 8), dtype=np.float32)',
        'r = mod.to_numpy([(Tensor(a),)], np, torch)',
        'print(json.dumps(list(r.shape)))',
      ].join('\n'));
      expect(JSON.parse(out)).toEqual([2, 8]);
    });
  });

  describe('to_stereo', () => {
    // Every layout the decoder can plausibly produce has to land on
    // (2, samples) float32 — the wave writer below it is hardcoded to stereo.
    it.each([
      ['channels-first stereo', '(2, 8)', [2, 8]],
      ['channels-last stereo', '(8, 2)', [2, 8]],
      ['mono, no channel dim', '(8,)', [2, 8]],
      ['mono with a channel dim', '(1, 8)', [2, 8]],
      ['leading batch dim', '(1, 2, 8)', [2, 8]],
    ])('orients %s to (2, samples)', (_label, shape, expected) => {
      const out = runPython([
        `a = np.arange(int(np.prod(${shape})), dtype=np.float64).reshape(${shape})`,
        'r = mod.to_stereo(a, np)',
        'print(json.dumps([list(r.shape), str(r.dtype)]))',
      ].join('\n'));
      expect(JSON.parse(out)).toEqual([expected, 'float32']);
    });

    it('duplicates a mono channel rather than transposing it', () => {
      const out = runPython([
        'a = np.array([[1.0, 2.0, 3.0]])',
        'r = mod.to_stereo(a, np)',
        'print(json.dumps(r.tolist()))',
      ].join('\n'));
      expect(JSON.parse(out)).toEqual([[1, 2, 3], [1, 2, 3]]);
    });

    it('raises on a shape it cannot orient', () => {
      expect(() => runPython([
        'a = np.zeros((3, 4, 5), dtype=np.float32)',
        'mod.to_stereo(a, np)',
      ].join('\n'))).toThrow();
    });
  });
});

describe.skipIf(!pyBin)('generate_minimax_music3 deterministic benchmark hook', () => {
  it('builds a CUDA generator for pipelines that expose generator', () => {
    const out = runPythonWithoutNumpy([
      'class Generator:',
      '    def __init__(self, device): self.device = device',
      '    def manual_seed(self, seed): self.seed = seed; return self',
      'class SeedTorch:',
      '    Generator = Generator',
      'class Supported:',
      '    def __call__(self, prompt, generator=None): pass',
      'r = mod.seeded_generation_kwargs(Supported(), SeedTorch, 17)["generator"]',
      'print(json.dumps({"device": r.device, "seed": r.seed}))',
    ].join('\n'));
    expect(JSON.parse(out)).toEqual({ device: 'cuda', seed: 17 });
  });

  it('does not claim deterministic support when generator is absent', () => {
    const out = runPythonWithoutNumpy([
      'class Unsupported:',
      '    def __call__(self, prompt): pass',
      'print(json.dumps(mod.seeded_generation_kwargs(Unsupported(), object(), 17)))',
    ].join('\n'));
    expect(JSON.parse(out)).toEqual({});
  });
});

describe.skipIf(!pyBin)('generate_minimax_music3 CUDA placement', () => {
  it('uses the ComponentsManager auto-offload hook and reports the effective profile', () => {
    const out = runPythonWithoutNumpy([
      'mod.choose_cuda_pipeline_placement = lambda *args, **kwargs: {"use_offload": True}',
      'class Pipe:',
      '    def to(self, device): raise AssertionError("full placement must not run")',
      'class Manager:',
      '    def enable_auto_cpu_offload(self, **kwargs): self.kwargs = kwargs',
      'manager = Manager()',
      'profile = mod.place_minimax_pipeline(Pipe(), manager, object())',
      'print(json.dumps({"profile": profile, "device": manager.kwargs["device"], "strategy": manager.kwargs["offload_strategy"].__name__}))',
    ].join('\n'));
    expect(JSON.parse(out)).toEqual({
      profile: 'cuda-bf16-component-offload',
      device: 'cuda',
      strategy: 'minimax_offload_strategy',
    });
  });

  it('keeps full CUDA residency when the measured reserve fits', () => {
    const out = runPythonWithoutNumpy([
      'mod.choose_cuda_pipeline_placement = lambda *args, **kwargs: {"use_offload": False}',
      'class Pipe:',
      '    def to(self, device): self.device = device',
      'pipe = Pipe()',
      'profile = mod.place_minimax_pipeline(pipe, object(), object())',
      'print(json.dumps({"profile": profile, "device": pipe.device}))',
    ].join('\n'));
    expect(JSON.parse(out)).toEqual({ profile: 'cuda-bf16-full', device: 'cuda' });
  });

  it('fails instead of pretending to offload when the runtime hook is unavailable', () => {
    expect(() => runPythonWithoutNumpy([
      'mod.choose_cuda_pipeline_placement = lambda *args, **kwargs: {"use_offload": True}',
      'mod.place_minimax_pipeline(object(), object(), object())',
    ].join('\n'))).toThrow();
  });

  it('preserves the autoregressive pair while evicting unrelated phases', () => {
    const out = runPythonWithoutNumpy([
      'class Hook:',
      '    def __init__(self, model_id): self.model_id = model_id',
      'hooks = [Hook("condition_encoder_101"), Hook("language_model_102"), Hook("rvq_depth_decoder_103")]',
      'pair = [h.model_id for h in mod.minimax_offload_strategy(hooks, "rvq_depth_decoder_103", None, None)]',
      'other = [h.model_id for h in mod.minimax_offload_strategy(hooks, "transformer", None, None)]',
      'print(json.dumps({"pair": pair, "other": other}))',
    ].join('\n'));
    expect(JSON.parse(out)).toEqual({
      pair: ['condition_encoder_101'],
      other: ['condition_encoder_101', 'language_model_102', 'rvq_depth_decoder_103'],
    });
  });
});
