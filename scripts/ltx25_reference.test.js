import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PY_SUBPROCESS_TIMEOUT_MS, PY_TEST_TIMEOUT_MS, resolveTestPython } from '../server/lib/testHelper.js';

const python = resolveTestPython();
const script = fileURLToPath(new URL('./ltx25_reference_test.py', import.meta.url));

describe.skipIf(!python)('LTX 2.5 reference sheet conditioning', () => {
  it('keeps the opening anchor, limits the adapter to stage one, and restores hooks', () => {
    expect(() => execFileSync(python, [script], {
      encoding: 'utf8', timeout: PY_SUBPROCESS_TIMEOUT_MS,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: 'pipe',
    })).not.toThrow();
  }, PY_TEST_TIMEOUT_MS);
});
