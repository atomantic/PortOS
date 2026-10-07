// Dependency-free subprocess fixtures: each workspace runs its own lifecycle cases.
import { existsSync, mkdirSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));

export function createVitestTempFixture(host, workspace, body) {
  const root = join(host, 'fixture');
  mkdirSync(root);
  symlinkSync(join(repo, workspace, 'node_modules'), join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  mkdirSync(join(root, 'src/test'), { recursive: true });
  writeFileSync(join(root, 'src/test/setup.js'), '');
  // Generated workflow suites need the same private, real coordinators as the
  // ordinary server runner, even though their setup omits unrelated mocks.
  writeFileSync(join(root, 'vitest.setup.js'), workspace === 'server'
    ? `import ${JSON.stringify(new URL('../../server/test/admissionSetup.js', import.meta.url).href)};\n`
    : '');
  const testFile = workspace === 'client' ? 'src/lifecycle.test.js' : 'lifecycle.test.js';
  writeFileSync(join(root, testFile), `
    import { test, expect } from 'vitest';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { writeFileSync } from 'node:fs';
    import { bootstrapVitestTempRoot } from ${JSON.stringify(new URL('./vitestTempRoot.js', import.meta.url).href)};
    test('lifecycle', async () => {
      const first = tmpdir();
      expect(bootstrapVitestTempRoot()).toBe(first);
      expect(process.env.PORTOS_TEST_TEMP_ROOT).toBe(first);
      ${body}
    });
  `);
  const env = { ...process.env, TMPDIR: host, TMP: host, TEMP: host, NODE_DISABLE_COMPILE_CACHE: '1' };
  delete env.PORTOS_TEST_TEMP_ROOT;
  delete env.VITEST_FAST;
  return {
    args: [join(repo, workspace, 'node_modules/vitest/vitest.mjs'), 'run',
      '--config', join(repo, workspace, 'vitest.config.js'), '--root', root, '--maxWorkers', '1'],
    options: { cwd: join(repo, workspace), env, encoding: 'utf8', timeout: 20000 },
  };
}

const READY_POLL_MS = 15;

function readinessAborted(signal) {
  const error = new Error('fixture readiness wait aborted');
  error.name = 'AbortError';
  if (signal?.reason) error.cause = signal.reason;
  return error;
}

/**
 * Resolve when `file` exists. `signal` is the only failure boundary — the
 * caller's test or process completion — so a sibling that is still importing
 * can still publish readiness. A shorter inner clock expires first and skips
 * the scenario the wait exists to run.
 */
export function waitForFixtureReady(file, { signal } = {}) {
  if (existsSync(file)) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(readinessAborted(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      watcher?.close();
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(readinessAborted(signal));
    const seen = () => { if (existsSync(file)) finish(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      watcher = watch(dirname(file), seen);
    } catch (error) {
      finish(error);
      return;
    }
    timer = setInterval(seen, READY_POLL_MS);
    if (signal?.aborted) finish(readinessAborted(signal));
    else seen();
  });
}

/** Sibling worker source: fail only after the lifecycle worker publishes readiness. */
export function fixtureReadyFailureSource(readyFile) {
  return `import { it } from 'vitest';
import { waitForFixtureReady } from ${JSON.stringify(fileURLToPath(import.meta.url))};
it('controlled sibling failure', async ({ signal }) => {
  await waitForFixtureReady(${JSON.stringify(readyFile)}, { signal });
  throw new Error('controlled sibling failure');
});
`;
}
