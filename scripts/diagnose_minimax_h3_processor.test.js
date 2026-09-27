import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const python = resolveTestPython();
const hasImageStack = (() => {
  if (!python) return false;
  try {
    execFileSync(python, ['-c', 'import numpy, PIL'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const script = fileURLToPath(new URL('./diagnose_minimax_h3_processor.py', import.meta.url));
const run = (source) => execFileSync(python, ['-c', source, script], { encoding: 'utf8' });

// A stand-in transformers exposing the checkpoint-declared processor and its
// PIL twin. Both normalize the way the real backends do — fused
// (x - 127.5) / 127.5 versus (x / 255 - 0.5) / 0.5 — so the production cases
// differ only by float32 rounding, and "resample" any axis off the 32px grid.
const load = `
import importlib.util, json, sys, tempfile, types
from pathlib import Path
import numpy as np

class ExampleImageProcessor:
    reorder = False
    @classmethod
    def from_pretrained(cls, path):
        assert Path(path, 'preprocessor_config.json').is_file()
        return cls()
    def normalize(self, pixels):
        return (pixels - np.float32(127.5)) / np.float32(127.5)
    def __call__(self, images, return_tensors):
        assert return_tensors == 'np'
        pixels = np.asarray(images[0], dtype=np.float32)
        height, width = (max(32, round(size / 32) * 32) for size in pixels.shape[:2])
        resampled = (height, width) != pixels.shape[:2]
        pixels = np.pad(pixels, ((0, max(0, height - pixels.shape[0])), (0, max(0, width - pixels.shape[1])), (0, 0)),
                        mode='edge')[:height, :width]
        values = self.normalize(pixels).reshape(-1, 16 * 16 * 3)
        if resampled:
            values = values + np.float32(self.resample_bias)
        if self.reorder:
            values = values[::-1]
        return {'pixel_values': values, 'image_grid_thw': np.array([[1, height // 16, width // 16]])}
    resample_bias = 0.0

class ExampleImageProcessorPil(ExampleImageProcessor):
    resample_bias = 1 / 127.5
    def normalize(self, pixels):
        return (pixels / np.float32(255) - np.float32(0.5)) / np.float32(0.5)

stub = types.ModuleType('transformers')
stub.__version__ = 'stub'
stub.ExampleImageProcessor, stub.ExampleImageProcessorPil = ExampleImageProcessor, ExampleImageProcessorPil
sys.modules['transformers'] = stub
spec = importlib.util.spec_from_file_location('processor_parity', sys.argv[1])
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
cases = [
    dict(id='canvas', width=96, height=64, production=True),
    dict(id='raw', width=90, height=70, production=False),
]
def processor_dir(root):
    Path(root, 'preprocessor_config.json').write_text(json.dumps({
        'image_processor_type': 'ExampleImageProcessorFast', 'patch_size': 16}))
    return Path(root)
`;

describe.skipIf(!hasImageStack)('H3 image-processor parity diagnostic', () => {
  // Catches a checker that fails on the expected off-canvas resampling gap, or
  // that treats fused-normalization rounding as divergence.
  it('passes when production canvases agree in bfloat16 and only reports off-canvas resampling', () => {
    expect(run(`${load}
with tempfile.TemporaryDirectory() as root:
    report = d.run(processor_dir(root), cases)
canvas, raw = report['cases']
assert report['production_parity'] is True, report
assert report['reference_processor'] == 'ExampleImageProcessor', report
assert report['twin_processor'] == 'ExampleImageProcessorPil', report
assert canvas['resampled'] is False and canvas['parity'] is True, canvas
assert 0 < canvas['max_abs'] <= d.FLOAT32_TOLERANCE and canvas['bfloat16_mismatch'] == 0, canvas
assert raw['resampled'] is True and raw['parity'] is False and raw['bfloat16_mismatch'] > 0, raw
print('ok')
`)).toContain('ok');
  });

  // Catches the regression the checker exists for: a twin (for example after a
  // transformers bump) that lays out patches differently on a production canvas.
  it('fails production parity and exits nonzero when the twin reorders patches', () => {
    expect(run(`${load}
ExampleImageProcessorPil.reorder = True
with tempfile.TemporaryDirectory() as root:
    report = d.run(processor_dir(root), cases)
    sys.argv = [sys.argv[0], '--processor-dir', root]
    status = d.main()
assert report['production_parity'] is False and report['cases'][0]['bfloat16_mismatch'] > 0, report
assert status == 1, status
print('ok')
`)).toContain('ok');
  });

  it('refuses a directory without a processor config instead of fetching one', () => {
    expect(run(`${load}
def forbidden(*args):
    raise AssertionError('processor loaded')
ExampleImageProcessor.from_pretrained = ExampleImageProcessorPil.from_pretrained = classmethod(forbidden)
with tempfile.TemporaryDirectory() as root:
    sys.argv = [sys.argv[0], '--processor-dir', root]
    try:
        d.main()
    except SystemExit as error:
        assert 'nothing is downloaded' in str(error), error
    else:
        raise AssertionError('missing config was accepted')
print('ok')
`)).toContain('ok');
  });
});
