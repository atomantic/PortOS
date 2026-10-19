import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PY_SUBPROCESS_TIMEOUT_MS, PY_TEST_TIMEOUT_MS, resolveTestPython } from '../server/lib/testHelper.js';

// The contracts need real MLX quantized modules, so prefer the LTX runtimes'
// own venvs and skip on a host with no MLX (CI's Linux/Windows runners).
const candidates = [
  join(homedir(), '.portos', 'ltx-2-mlx', '.venv', 'bin', 'python'),
  join(homedir(), '.portos', 'ltx-2.5-mlx', '.venv', 'bin', 'python'),
  resolveTestPython(),
].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index
  && (!candidate.includes('/') || existsSync(candidate)));
const python = candidates.find((candidate) => {
  try {
    execFileSync(candidate, ['-c', 'import mlx.core, mlx.nn'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}) || null;
const testScript = fileURLToPath(new URL('./ltx_runtime_lora_test.py', import.meta.url));

describe.skipIf(!python)('ltx_runtime_lora.py', () => {
  it('keeps quantized adapter deltas a merge loses and scopes IC adapters to stage 1', () => {
    expect(() => execFileSync(python, [testScript], {
      encoding: 'utf8',
      timeout: PY_SUBPROCESS_TIMEOUT_MS,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: 'pipe',
    })).not.toThrow();
  }, PY_TEST_TIMEOUT_MS);
});
