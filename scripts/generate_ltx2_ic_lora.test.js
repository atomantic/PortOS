import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PY_SUBPROCESS_TIMEOUT_MS, PY_TEST_TIMEOUT_MS, resolveTestPython } from '../server/lib/testHelper.js';

// Stdlib-only: the runtime is faked, so this runs on any interpreter.
const python = resolveTestPython();
const testScript = fileURLToPath(new URL('./generate_ltx2_ic_lora_test.py', import.meta.url));

describe.skipIf(!python)('generate_ltx2.py IC-LoRA runner', () => {
  it('enforces the reference contract and routes adapters around merge-and-requantize', () => {
    expect(() => execFileSync(python, [testScript], {
      encoding: 'utf8',
      timeout: PY_SUBPROCESS_TIMEOUT_MS,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: 'pipe',
    })).not.toThrow();
  }, PY_TEST_TIMEOUT_MS);
});
