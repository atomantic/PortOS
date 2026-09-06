import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const python = resolveTestPython();
const testScript = fileURLToPath(new URL('./reactor_render_test.py', import.meta.url));

describe.skipIf(!python)('Reactor stream capture lifecycle', () => {
  it('captures decoder tails, rejects incomplete streams, and reaps cancelled encoders offline', () => {
    expect(() => execFileSync(python, [testScript], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: 'pipe',
    })).not.toThrow();
  });
});
