// Exercises align_lyrics_ctc.py via its model-free Python boundary tests. The
// Viterbi cases need numpy, so a numpy-capable interpreter is preferred.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveTestPython, PY_TEST_TIMEOUT_MS, PY_SUBPROCESS_TIMEOUT_MS } from '../server/lib/testHelper.js';

const python = resolveTestPython({ modules: ['numpy'] }) ?? resolveTestPython();
describe.skipIf(!python)('CTC Python transcript, Viterbi and checkpoint gate', () => {
  it('runs the production boundary checks without downloading or deserializing a model', () => {
    expect(() => execFileSync(python, [fileURLToPath(new URL('./align_lyrics_ctc_test.py', import.meta.url))],
      { timeout: PY_SUBPROCESS_TIMEOUT_MS, stdio: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })).not.toThrow();
  }, PY_TEST_TIMEOUT_MS);
});
