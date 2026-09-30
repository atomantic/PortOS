import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const python = resolveTestPython();
const commonScript = fileURLToPath(new URL('./_runner_common.py', import.meta.url));
const qwenRunner = fileURLToPath(new URL('./z_image_turbo.py', import.meta.url));
const runnerContract = fileURLToPath(new URL('./z_image_turbo_test.py', import.meta.url));
const hasPillow = python && spawnSync(python, ['-c', 'import PIL'], { stdio: 'ignore' }).status === 0;

const exerciseGuard = `
import importlib.util, json, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("runner_common", sys.argv[1])
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)

class Reduction:
    def __init__(self, value):
        self.value = value
    def all(self):
        return self
    def item(self):
        return self.value

attempts = []
def first():
    attempts.append("first")
    return "nan"
def retry():
    attempts.append("retry")
    return "finite"
def isfinite(value):
    return Reduction(value == "finite")

decoded, retried = common.decode_with_finite_retry(first, retry, isfinite)
failed_closed = False
try:
    common.decode_with_finite_retry(lambda: "nan", lambda: "nan", isfinite)
except FloatingPointError:
    failed_closed = True
print(json.dumps({"decoded": decoded, "retried": retried, "attempts": attempts, "failedClosed": failed_closed}))
`;

describe.skipIf(!python)('Qwen Image 2.1 MPS decode guard', () => {
  it('retries non-finite output once and fails closed if float32 is still non-finite', () => {
    const output = execFileSync(python, ['-c', exerciseGuard, commonScript], { encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual({
      decoded: 'finite',
      retried: true,
      attempts: ['first', 'retry'],
      failedClosed: true,
    });
  });

});

describe('Qwen Image 2.1 runner contract', () => {
  it('owns the Qwen MPS latent decode and reports model/reference diagnostics', () => {
    const source = readFileSync(qwenRunner, 'utf8');
    expect(source).toContain('decode_with_finite_retry');
    expect(source).toContain('pipe_kwargs["output_type"] = "latent"');
    expect(source).toContain('USER_ERROR:qwen_mps_nan');
    expect(source).toContain('references={len(args.reference_images)}');
  });

  it.skipIf(!hasPillow)('preserves generation/edit inputs and model-aware logs without model weights', () => {
    expect(() => execFileSync(python, [runnerContract], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: 'pipe',
    })).not.toThrow();
  });
});
