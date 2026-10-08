// Exercises align_lyrics_ctc.py via its dependency-free Python boundary tests.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveTestPython, PY_TEST_TIMEOUT_MS, PY_SUBPROCESS_TIMEOUT_MS } from '../server/lib/testHelper.js';

const python = resolveTestPython();
describe.skipIf(!python)('CTC Python transcript and emission clock', () => {
  it('runs the production boundary checks without downloading a model', () => {
    expect(() => execFileSync(python, [fileURLToPath(new URL('./align_lyrics_ctc_test.py', import.meta.url))],
      { timeout: PY_SUBPROCESS_TIMEOUT_MS, stdio: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })).not.toThrow();
  }, PY_TEST_TIMEOUT_MS);
});
