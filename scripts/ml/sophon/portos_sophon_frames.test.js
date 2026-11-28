// test-memo: never — interpreter availability alone cannot prove NumPy ran.
// Runs the realtime voice sidecar's playback-reference framing and speech-detector regressions (#20512) without model weights.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveTestPython, PY_TEST_TIMEOUT_MS, PY_SUBPROCESS_TIMEOUT_MS } from '../../../server/lib/testHelper.js';

const python = resolveTestPython({ modules: ['numpy'] });

describe.skipIf(!python)('realtime voice sidecar playback reference', () => {
  // Literal path references: the CI test planner selects this suite for edits to these modules only when a test names them.
  it('targets the production modules', () => {
    expect(existsSync(fileURLToPath(new URL('./portos_sophon_frames.py', import.meta.url)))).toBe(true);
    expect(existsSync(fileURLToPath(new URL('./portos_sophon.py', import.meta.url)))).toBe(true);
  });

  it('frames mic and reference audio and keeps echo from cutting a reply while near-end speech still does', () => {
    expect(() => execFileSync(python, [fileURLToPath(new URL('./portos_sophon_frames_test.py', import.meta.url))],
      { timeout: PY_SUBPROCESS_TIMEOUT_MS, stdio: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })).not.toThrow();
  }, PY_TEST_TIMEOUT_MS);
});
