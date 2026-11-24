// Runs the weightless FLUX.2 revision-pinning contract checks (ast only; no torch, no network).
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveTestPython, PY_TEST_TIMEOUT_MS, PY_SUBPROCESS_TIMEOUT_MS } from '../server/lib/testHelper.js';

const python = resolveTestPython();
describe.skipIf(!python)('flux2_macos.py revision pinning contract', () => {
  it('targets the production modules', () => {
    expect(existsSync(fileURLToPath(new URL('./ml/flux2_macos.py', import.meta.url)))).toBe(true);
    expect(existsSync(fileURLToPath(new URL('./ml/flux2_quantized.py', import.meta.url)))).toBe(true);
  });

  it('forwards revision= to every Hub call and refuses unpinned remote ids', () => {
    expect(() => execFileSync(python, [fileURLToPath(new URL('./ml/flux2_macos_test.py', import.meta.url))],
      { timeout: PY_SUBPROCESS_TIMEOUT_MS, stdio: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })).not.toThrow();
  }, PY_TEST_TIMEOUT_MS);
});
