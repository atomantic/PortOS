// Exercises align_lyrics_ctc.py via its model-free Python boundary tests. The
// Viterbi cases need numpy, so a numpy-capable interpreter is preferred.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveTestPython, PY_TEST_TIMEOUT_MS, PY_SUBPROCESS_TIMEOUT_MS } from '../server/lib/testHelper.js';

const numpyPython = resolveTestPython({ modules: ['numpy'] });
// ci.yml sets CI_EXPECT_NUMPY_PYTHON after provisioning a numpy venv: fail instead of silently skipping the Viterbi cases (#15676).
if (process.env.CI_EXPECT_NUMPY_PYTHON === 'true' && !numpyPython) {
  throw new Error('no numpy-capable Python resolved but this CI job expected one (see the numpy venv step in ci.yml)');
}
const python = numpyPython ?? resolveTestPython();
describe.skipIf(!python)('CTC Python transcript, Viterbi and checkpoint gate', () => {
  // Literal path reference: the CI test planner (path-contract index) selects this
  // suite for edits to the Python module only when a test names it (#15676).
  it('targets the production module', () => {
    expect(existsSync(fileURLToPath(new URL('./align_lyrics_ctc.py', import.meta.url)))).toBe(true);
  });

  it('runs the production boundary checks without downloading or deserializing a model', () => {
    expect(() => execFileSync(python, [fileURLToPath(new URL('./align_lyrics_ctc_test.py', import.meta.url))],
      { timeout: PY_SUBPROCESS_TIMEOUT_MS, stdio: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })).not.toThrow();
  }, PY_TEST_TIMEOUT_MS);
});
