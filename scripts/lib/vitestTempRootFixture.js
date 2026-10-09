// Dependency-free subprocess fixtures: each workspace runs its own lifecycle cases.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, watch, writeFileSync } from 'node:fs';
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
  // The fixture's main process is not a pool worker of the suite spawning it.
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
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

const WATCH_READY_MS = 60000;

function killProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL'); // detached: the child leads its own group
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Run the real workspace config under `vitest --watch`, edit the config to force
 * a restart ("Restarting due to config changes"), and hand the restarted run's
 * observations to `inspect`. The fixture test records `{ root, owner }` into a
 * numbered marker per run, so readiness is event-driven and bounded by
 * WATCH_READY_MS. The process tree is always killed before returning.
 */
export async function runWatchConfigRestart(host, workspace, inspect) {
  const marks = join(host, 'marks');
  mkdirSync(marks);
  const { args, options } = createVitestTempFixture(host, workspace, `
      const fs = await import('node:fs');
      const marks = process.env.VRT_MARKS;
      const n = fs.readdirSync(marks).filter((name) => name.endsWith('.json')).length + 1;
      const record = JSON.stringify({ root: first, owner: fs.readFileSync(join(first, '.owner.pid'), 'utf8') });
      fs.writeFileSync(join(marks, 'pending'), record);
      fs.renameSync(join(marks, 'pending'), join(marks, 'run-' + n + '.json'));
  `);
  // A wrapper config in the fixture is the file the watcher restarts on; it
  // loads the workspace's actual config, so editing it never touches the repo.
  // Real path: the watcher reports canonical paths (macOS tmpdir is a symlink),
  // and a config file it cannot match is a plain rerun, not a restart.
  const wrapper = join(realpathSync(host), 'fixture', 'vitest.config.mjs');
  writeFileSync(wrapper, `export { default } from ${JSON.stringify(join(repo, workspace, 'vitest.config.js'))};\n`);
  const cfg = args.indexOf('--config') + 1;
  args[cfg] = wrapper;
  args[args.indexOf('--root') + 1] = dirname(wrapper);
  args.splice(args.indexOf('run'), 1, '--watch');
  const { timeout: _bounded, ...spawnOptions } = options; // readiness below bounds the run
  const child = spawn(process.execPath, args, {
    ...spawnOptions,
    env: { ...options.env, VRT_MARKS: marks },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('watch fixture readiness timed out')), WATCH_READY_MS);
  child.once('exit', () => abort.abort(new Error('watch fixture exited before readiness')));
  const readMark = async (n) => {
    const file = join(marks, `run-${n}.json`);
    await waitForFixtureReady(file, { signal: abort.signal });
    return JSON.parse(readFileSync(file, 'utf8'));
  };
  try {
    const first = await readMark(1);
    appendFileSync(wrapper, '// force a config restart\n');
    const restarted = await readMark(2);
    return await inspect({ first, restarted, pid: child.pid });
  } catch (error) {
    error.message += `\n${output}`;
    throw error;
  } finally {
    clearTimeout(timer);
    killProcessTree(child);
  }
}
