import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PY_SUBPROCESS_TIMEOUT_MS, PY_TEST_TIMEOUT_MS, resolveTestPython } from '../server/lib/testHelper.js';

// The contracts need real MLX quantized modules, so prefer the LTX runtimes'
// own venvs and skip on a host with no MLX (CI's Linux/Windows runners).
// CPU compilation can create an `mlx` cache under the subprocess temp root.
// Own that root for probes and fixtures, and remove it even when Python fails.
const runPython = (binary, args, options = {}) => {
  const temp = mkdtempSync(join(tmpdir(), 'ltx-adapter-fixture-'));
  try {
    return execFileSync(binary, args, { ...options,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', TMPDIR: temp, TMP: temp, TEMP: temp },
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
};

const candidates = [
  join(homedir(), '.portos', 'ltx-2-mlx', '.venv', 'bin', 'python'),
  join(homedir(), '.portos', 'ltx-2.5-mlx', '.venv', 'bin', 'python'),
  resolveTestPython(),
].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index
  && (!candidate.includes('/') || existsSync(candidate)));
const python = candidates.find((candidate) => {
  try {
    runPython(candidate, ['-c', 'import mlx.core, mlx.nn'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}) || null;
const testScript = fileURLToPath(new URL('./ltx_runtime_lora_test.py', import.meta.url));

describe.skipIf(!python)('ltx_runtime_lora.py', () => {
  it('keeps quantized deltas, IC roles and reversible A2V stages across CPU, streamed and failure paths', () => {
    expect(() => runPython(python, [testScript], {
      encoding: 'utf8',
      timeout: PY_SUBPROCESS_TIMEOUT_MS,
      stdio: 'pipe',
    })).not.toThrow();
  }, PY_TEST_TIMEOUT_MS);
});
