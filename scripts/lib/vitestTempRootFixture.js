// Dependency-free subprocess fixtures: each workspace runs its own lifecycle cases.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));

export function createVitestTempFixture(host, workspace, body, config = 'vitest.config.js') {
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
  const testFile = config === 'vitest.config.db.js' ? 'db.test.js'
    : workspace === 'client' ? 'src/lifecycle.test.js' : 'lifecycle.test.js';
  writeFileSync(join(root, testFile), `
    import { test, expect } from 'vitest';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { writeFileSync } from 'node:fs';
    import { bootstrapVitestTempRoot } from ${JSON.stringify(new URL('./vitestTempRoot.js', import.meta.url).href)};
    test('lifecycle', async () => {
      const first = tmpdir();
      // Check before re-bootstrap: the real config must already have forwarded
      // Chromium's macOS temp override into every workspace worker.
      expect(process.env.MAC_CHROMIUM_TMPDIR).toBe(first);
      expect(bootstrapVitestTempRoot()).toBe(first);
      expect(process.env.PORTOS_TEST_TEMP_ROOT).toBe(first);
      ${body}
    });
  `);
  const env = { ...process.env, TMPDIR: host, TMP: host, TEMP: host, NODE_DISABLE_COMPILE_CACHE: '1' };
  // These synthetic lifecycle fixtures never use a database. A private,
  // unprovisioned test name keeps the real DB config from queuing behind an
  // unrelated portos_test run before temp-root assertions can execute.
  if (config === 'vitest.config.db.js') env.PGTESTDATABASE = `pvt_${randomUUID().replaceAll('-', '')}_test`;
  delete env.PORTOS_TEST_TEMP_ROOT;
  delete env.VITEST_FAST;
  // The fixture's main process is not a pool worker of the suite spawning it.
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  return {
    args: [join(repo, workspace, 'node_modules/vitest/vitest.mjs'), 'run', '--configLoader', 'runner',
      '--config', join(repo, workspace, config), '--root', root, '--maxWorkers', '1'],
    options: { cwd: join(repo, workspace), env, encoding: 'utf8', timeout: 20000 },
  };
}

const READY_POLL_MS = 15;

function fixtureAborted(signal, message = 'fixture readiness wait aborted') {
  const error = new Error(message);
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
  if (signal?.aborted) return Promise.reject(fixtureAborted(signal));
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
    const onAbort = () => finish(fixtureAborted(signal));
    const seen = () => { if (existsSync(file)) finish(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      watcher = watch(dirname(file), seen);
    } catch (error) {
      finish(error);
      return;
    }
    timer = setInterval(seen, READY_POLL_MS);
    if (signal?.aborted) finish(fixtureAborted(signal));
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

// Measured: the whole watch test takes ~30s idle and ~50s under 2x CPU oversubscription
// (a loaded full client run), so 60s left no headroom (#12834). Readiness is event-driven;
// this only bounds a hang.
const WATCH_READY_MS = 120000;
const FIXTURE_RUN_CEILING_MS = 120000;
const WATCH_IDLE_LINE = 'Waiting for file changes';
const WATCH_EDIT_RETRY_MS = 5000;

function waitUntil(predicate, signal) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) { clearInterval(timer); signal.removeEventListener('abort', onAbort); resolve(); }
    };
    const onAbort = () => { clearInterval(timer); reject(fixtureAborted(signal)); };
    const timer = setInterval(check, READY_POLL_MS);
    if (signal.aborted) onAbort();
    else { signal.addEventListener('abort', onAbort, { once: true }); check(); }
  });
}

// `sweepGroup` also signals after the leader exited: its detached group can
// outlive it (a worker holding the output pipes), and the pgid stays valid
// while any member lives.
function killProcessTree(child, { sweepGroup = false } = {}) {
  if (!child.pid || (child.exitCode !== null && !sweepGroup)) return;
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
 * Run a fixture to completion. The only clock is one generous ceiling — a cold
 * import graph on a loaded host can take over a minute, so `createVitestTempFixture`'s
 * fixed `timeout` (kept for spawnSync callers) is dropped. Resolves like spawnSync's
 * result; `error` is set only when the ceiling is reached or `signal` aborts, after
 * the whole detached process group is killed. Pass the calling test's `signal`:
 * a fail-fast cancellation otherwise leaves the body awaiting the nested run while
 * the worker tears down, so its `finally` never removes the host (#12924).
 */
export function runFixtureToCompletion({ args, options }, ceilingMs = FIXTURE_RUN_CEILING_MS, { signal } = {}) {
  const { timeout: _bounded, ...spawnOptions } = options;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      ...spawnOptions,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let error;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      killProcessTree(child, { sweepGroup: true }); // reap any worker the run left behind
      resolve({ status, stdout, stderr, error });
    };
    const timer = setTimeout(() => {
      error = new Error(`fixture run exceeded ${ceilingMs}ms`);
      killProcessTree(child, { sweepGroup: true });
      // A survivor holding the pipes would defer 'close'; settle regardless.
      setTimeout(() => finish(null), 2000);
    }, ceilingMs);
    const abort = () => {
      error = fixtureAborted(signal, 'fixture run aborted');
      killProcessTree(child, { sweepGroup: true });
      setTimeout(() => finish(null), 2000);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (spawnError) => { error = spawnError; finish(null); });
    child.once('close', finish);
    // Output ends at 'close', which a surviving worker holding the pipes defers:
    // sweep the group as soon as the leader exits, with a bounded wait for the pipes.
    child.once('exit', () => {
      killProcessTree(child, { sweepGroup: true });
      setTimeout(() => finish(child.exitCode), 2000);
    });
  });
}

/**
 * Run the real workspace config under `vitest --watch`, edit the config to force
 * a restart ("Restarting due to config changes"), and hand the restarted run's
 * observations to `inspect`. The fixture test records `{ root, owner }` into a
 * numbered marker per run, so readiness is event-driven and bounded by
 * WATCH_READY_MS. Caller cancellation stops readiness; returning waits for the
 * killed watcher to close. FIXTURE_CLOSE_UNCONFIRMED means retain the host.
 */
export async function runWatchConfigRestart(host, workspace, inspect, { signal } = {}) {
  if (signal?.aborted) throw fixtureAborted(signal);
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
  // Register before any signal: removal of the host must follow process AND
  // pipe settlement, not merely the synchronous kill request.
  const abort = new AbortController();
  let closed = false;
  let spawnError;
  const completion = new Promise(resolve => {
    child.once('close', () => { closed = true; resolve(); });
  });
  child.once('error', error => { spawnError = error; abort.abort(error); });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const onAbort = () => abort.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => abort.abort(new Error('watch fixture readiness timed out')), WATCH_READY_MS);
  child.once('exit', () => abort.abort(new Error('watch fixture exited before readiness')));
  const readMark = async (n) => {
    const file = join(marks, `run-${n}.json`);
    await waitForFixtureReady(file, { signal: abort.signal });
    return JSON.parse(readFileSync(file, 'utf8'));
  };
  let failure;
  try {
    const first = await readMark(1);
    // run-1 is written from inside the first test, possibly before the watcher has
    // registered the config; an edit in that window is never observed (#12932).
    await waitUntil(() => output.includes(WATCH_IDLE_LINE), abort.signal);
    // Still re-append on a cadence: each edit is idempotent for the fixture, and a
    // missed one is retried inside the WATCH_READY_MS bound.
    const restartFile = join(marks, 'run-2.json');
    const edit = () => { if (!existsSync(restartFile)) appendFileSync(wrapper, '// force a config restart\n'); };
    edit();
    const retry = setInterval(edit, WATCH_EDIT_RETRY_MS);
    let restarted;
    try {
      restarted = await readMark(2);
    } finally {
      clearInterval(retry);
    }
    return await inspect({ first, restarted, pid: child.pid });
  } catch (error) {
    failure = spawnError ?? error;
    failure.message += `\n${output}`;
    throw failure;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    killProcessTree(child, { sweepGroup: true });
    if (!closed) {
      let closeTimer;
      try {
        await Promise.race([completion, new Promise((_, reject) => {
          closeTimer = setTimeout(() => reject(new Error('watch fixture process close unconfirmed')), 2000);
        })]);
      } catch (error) {
        const cleanupError = failure
          ? new AggregateError([failure, error], 'watch fixture failed and process close is unconfirmed', { cause: failure })
          : error;
        cleanupError.code = 'FIXTURE_CLOSE_UNCONFIRMED';
        throw cleanupError;
      } finally {
        clearTimeout(closeTimer);
      }
    }
  }
}
