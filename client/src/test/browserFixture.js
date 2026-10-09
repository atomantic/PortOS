/**
 * Phase-bounded startup for the real-Chromium `*.browser.test.js` fixtures.
 *
 * A fixture starts three things in sequence: a Vite dev server, a Chromium
 * process, and a first page that compiles the cold module graph. Bounding them
 * only with one aggregate `beforeAll` timeout has two faults (#10543):
 *
 * - a stall reports a bare "Hook timed out in 60000ms" that names no phase;
 * - the timed-out hook keeps running, so a Chromium or Vite server that comes
 *   up after the deadline is assigned to a variable `afterAll` already read,
 *   and nobody closes it.
 *
 * Here each phase has its own deadline, the deadlines plus the cleanup budget
 * fit inside `BROWSER_FIXTURE_STARTUP_MS`, and a failure closes everything the
 * fixture already owns — including a resource whose phase settles after its
 * deadline — before rejecting with an error naming the phase and the timings
 * of the phases that completed.
 *
 * The phase that actually stalled under load was the warmup, and its cost was
 * not the fixture's own modules: with `configFile: false` and no
 * `optimizeDeps.entries`, Vite globs every `.html` under the root, finds `client/index.html`,
 * crawls the WHOLE app, and pre-bundles three.js, drei, recharts, xterm, … before
 * it answers the first request. So the config must scope dependency discovery
 * to what the fixture renders: `entries` names the real source files and
 * `include` the bare imports of the virtual fixture module (which the scanner
 * cannot see; leaving them to runtime discovery forces a re-optimize + reload).
 *
 * The Chromium launch is the other phase that stalls on CI (#10635), and only
 * there: locally it takes 0.6–1.7s even with a cold page cache and every core
 * busy, while on a GitHub runner two first launches timed out together at 15s
 * with Vite already up in under 100ms. The DB-suite launcher caught the same
 * stall in the act (#9641): Chrome alive in uninterruptible sleep, waiting on
 * page faults, under heavy I/O pressure. That points to a runner whose disk
 * stalls, not a launch that needs more CPU, so the launch gets two attempts: a
 * first one killed at half the phase, and a fresh process for the rest. The
 * pages the first attempt did read stay in the kernel's cache, so a slow disk
 * loses no progress, and a child that wedged is replaced rather than waited
 * on. Vite's budget pays for it: it starts in well under 2s even under load.
 *
 * The retry hides the stall it recovers from, and the launch error names no
 * state, so each attempt also observes its own browser child shortly before
 * its deadline, with the DB launcher's redacted Linux process facts (#9641).
 * Those facts are reported only for an attempt that then timed out: in the
 * startup error, or on the ready line when the retry recovered. A launch that
 * settles first discards them. Vitest's CI `--silent=passed-only` drops a
 * passing fixture's console output, so on GitHub Actions the ready and failure
 * lines are also appended to the job's step summary, which keeps the passing
 * timings for comparison with the runner's Chrome warm-up.
 */
import { appendFileSync, closeSync, openSync, opendirSync, readSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _testChromeProcessFacts } from '../../../server/services/htmlComposition/testBrowserCleanup.js';

export const BROWSER_FIXTURE_STARTUP_MS = 60000;

export const BROWSER_FIXTURE_PHASE_MS = Object.freeze({
  vite: 5000,
  chromium: 24000,
  warmup: 25000,
  cleanup: 5000,
});

const PHASE_NAMES = { vite: 'Vite server start', chromium: 'Chromium launch', warmup: 'first page warmup' };

const timeoutError = ms => Object.assign(new Error(`timed out after ${ms}ms`), { name: 'TimeoutError' });

// Linux-only, bounded reads: up to 64 worker threads' `children` lists and one
// 4096-byte stat prefix per child. Never read cmdline, environ or links, and
// never print a PID or process name — only counts and the shared process facts.
const readPrefix = (path) => {
  const fd = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(4096);
    return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString();
  } finally { closeSync(fd); }
};
const listDir = (path) => {
  const dir = opendirSync(path);
  const names = [];
  try {
    let entry;
    for (let count = 0; count < 64 && (entry = dir.readSync()); count++) names.push(entry.name);
  } finally { dir.closeSync(); }
  return names;
};
const BROWSER_PROCESS_NAME = /^(chrome|chromium|google-chrome|headless_shell|chrome-headless)/;

/**
 * Starts observing one launch attempt: the worker's browser children that
 * already exist (an earlier attempt still exiting) are excluded, and the
 * returned function describes the one browser child that appeared since. Only
 * a direct child of this worker is ever inspected, so the PID is owned; the
 * shared facts re-check that its parent is this worker.
 */
export function _observeOwnedBrowserLaunch({
  platform = process.platform, workerPid = process.pid, read = readPrefix, list = listDir,
  processFacts = _testChromeProcessFacts,
} = {}) {
  if (platform !== 'linux') return () => 'os=unsupported';
  // A thread or child that exits between the listing and its read is skipped,
  // but no readable `children` list at all (a kernel without them) means the
  // observation is unavailable — never an empty one.
  const readOrNull = (path) => { try { return read(path); } catch { return null; } };
  const browserChildren = () => {
    const pids = new Set();
    let readable = false;
    for (const tid of list(`/proc/${workerPid}/task`).filter(name => /^[1-9]\d*$/.test(name))) {
      const children = readOrNull(`/proc/${workerPid}/task/${tid}/children`);
      if (children === null) continue;
      readable = true;
      for (const pid of children.trim().split(/\s+/)) {
        if (!/^[1-9]\d*$/.test(pid)) continue;
        const stat = readOrNull(`/proc/${pid}/stat`) ?? '';
        const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
        if (BROWSER_PROCESS_NAME.test(name)) pids.add(pid);
      }
    }
    if (!readable) throw new Error('no readable children list');
    return pids;
  };
  let earlier;
  try { earlier = browserChildren(); } catch { earlier = null; }
  return () => {
    if (!earlier) return 'browserChildren=unavailable';
    let fresh;
    try { fresh = [...browserChildren()].filter(pid => !earlier.has(pid)); }
    catch { return 'browserChildren=unavailable'; }
    if (fresh.length !== 1) return `browserChildren=${fresh.length}`;
    return `browserChildren=1 ${processFacts({ pid: Number(fresh[0]), exitCode: null, signalCode: null }, { workerPid })}`;
  };
}

// Appends one line to the GitHub Actions step summary, when there is one. The
// summary only retains evidence: a write failure never changes the fixture.
const retainLine = (line) => {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  try { appendFileSync(summary, `- ${line}\n`); } catch { /* evidence only */ }
};

const withDeadline = (promise, ms, onTimeout) => {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

/**
 * @param {object} options
 * @param {string} options.name - fixture label used in errors and the temp-dir prefix
 * @param {Function} options.createServer - vite's `createServer`
 * @param {(temp: string) => object} options.viteConfig - inline Vite config; `temp` is the fixture's private temp dir
 * @param {object} options.chromium - playwright-core's `chromium`, or any `{ launch }` stand-in (e.g. one wrapping `connectOverCDP`)
 * @param {object} [options.launchOptions] - extra `chromium.launch` options (executablePath, args, …)
 * @param {(page: object, origin: string) => Promise<void>} [options.warmup] - first navigation; the page is closed afterward
 * @param {object} [options.phaseMs] - per-phase budgets; defaults to BROWSER_FIXTURE_PHASE_MS
 * @param {() => () => string} [options.observeLaunch] - starts observing a launch attempt; defaults to _observeOwnedBrowserLaunch
 * @returns {Promise<{ origin: string, browser: object, server: object, temp: string, close: () => Promise<void> }>}
 */
export async function startBrowserFixture({
  name, createServer, viteConfig, chromium, launchOptions = {}, warmup, phaseMs = BROWSER_FIXTURE_PHASE_MS,
  observeLaunch = _observeOwnedBrowserLaunch,
}) {
  const budget = phaseMs.vite + phaseMs.chromium + phaseMs.warmup + phaseMs.cleanup;
  if (budget >= BROWSER_FIXTURE_STARTUP_MS) {
    throw new Error(`${name} phase budgets (${budget}ms) must fit inside the ${BROWSER_FIXTURE_STARTUP_MS}ms startup hook`);
  }
  const temp = await mkdtemp(join(tmpdir(), `${name}-`));
  const closers = [];
  const completed = [];
  let failed = false;
  // A resource acquired after its phase already failed is closed at once
  // instead of leaking past the hook that abandoned it.
  const own = (closer) => {
    if (failed) closer().catch(() => {});
    else closers.push(closer);
  };
  const closeOwned = async () => {
    const errors = [];
    for (const closer of closers.splice(0).reverse()) {
      await closer().catch(error => errors.push(error.message));
    }
    await rm(temp, { recursive: true, force: true });
    if (errors.length) throw new Error(errors.join('; '));
  };
  let phase;
  // Appended to the phase's timing or timeout once its work had to retry.
  let retried = '';
  const runPhase = async (key, work) => {
    phase = key;
    const started = Date.now();
    const value = await withDeadline(Promise.resolve().then(work), phaseMs[key], () => {
      const error = timeoutError(phaseMs[key]);
      error.message += retried;
      return error;
    });
    completed.push(`${PHASE_NAMES[key]} ${Date.now() - started}ms${retried}`);
    retried = '';
    return value;
  };
  // Facts of every launch attempt that timed out, in attempt order, and the
  // recorder of the attempt in flight.
  const launchFacts = [];
  let recordTimedOutAttempt;
  // One Chromium process. A browser that arrives after its attempt was
  // abandoned is closed at once; one that arrives in time joins `own`, which
  // closes it at once if the fixture has failed meanwhile. Shortly before its
  // deadline, an attempt still pending samples its child: Playwright's own
  // launch timeout kills that child at the deadline, so a later look would
  // describe the kill rather than the stall.
  const launchOnce = (timeout) => {
    const number = launchFacts.length + 1;
    let abandoned = false;
    let settled = false;
    let recorded = false;
    let facts;
    let sample;
    try { sample = observeLaunch(); } catch { sample = () => 'unavailable'; }
    const sampleAt = timeout - Math.min(1000, Math.floor(timeout / 10));
    const timer = setTimeout(() => {
      if (settled) return;
      try { facts = sample(); } catch { facts = 'unavailable'; }
    }, sampleAt);
    const settle = () => { settled = true; clearTimeout(timer); };
    const launching = chromium.launch({
      headless: true,
      timeout,
      ...launchOptions,
      env: { ...process.env, ...launchOptions.env, TMPDIR: temp, TMP: temp, TEMP: temp },
    }).then((launched) => {
      settle();
      if (abandoned) launched.close().catch(() => {});
      else own(() => launched.close());
      return launched;
    }, (error) => { settle(); throw error; });
    const record = () => {
      if (recorded) return;
      recorded = true;
      settle();
      launchFacts.push(facts === undefined ? `attempt ${number}: not sampled` : `attempt ${number} at ${sampleAt}ms: ${facts}`);
    };
    recordTimedOutAttempt = record;
    return { launching, abandon: () => { abandoned = true; record(); } };
  };
  const describeLaunchFacts = () => (launchFacts.length ? `; launch facts: ${launchFacts.join('; ')}` : '');

  try {
    const server = await runPhase('vite', async () => {
      const config = viteConfig(temp);
      if (!config.optimizeDeps?.entries?.length) {
        throw new Error('viteConfig must set optimizeDeps.entries to the rendered source files, or Vite scans the whole app');
      }
      const vite = await createServer(config);
      own(() => vite.close());
      // A server that arrives after the deadline was just closed by own();
      // listening would bind a port nothing closes.
      if (failed) return vite;
      await vite.listen();
      // The deadline passed while listen() was binding: cleanup already ran.
      if (failed) await vite.close();
      return vite;
    });
    const origin = server.resolvedUrls.local[0];
    const browser = await runPhase('chromium', async () => {
      // Playwright's own launch timeout kills the child it spawned; each
      // deadline here is the backstop if that kill itself hangs. Only a
      // timeout earns the retry: a launch that fails outright (missing
      // executable, crash) fails the same way twice.
      const firstMs = Math.floor(phaseMs.chromium / 2);
      const first = launchOnce(firstMs);
      try {
        return await withDeadline(first.launching, firstMs, () => timeoutError(firstMs));
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        first.abandon();
        retried = ` (retried after a first attempt timed out after ${firstMs}ms)`;
      }
      return launchOnce(phaseMs.chromium - firstMs).launching;
    });
    if (warmup) {
      await runPhase('warmup', async () => {
        const page = await browser.newPage();
        try {
          await warmup(page, origin);
        } finally {
          await page.close();
        }
      });
    }
    // Passing runs record their phase timings too, so CI logs show how close
    // each budget runs before one of them fails.
    const ready = `🧪 ${name} browser fixture ready (${completed.join(', ')}${describeLaunchFacts()})`;
    console.log(ready);
    retainLine(ready);
    return { origin, browser, server, temp, close: closeOwned };
  } catch (error) {
    failed = true;
    // The phase deadline abandons the attempt in flight; Playwright's own
    // launch timeout carries the same error name. A crash records nothing.
    if (phase === 'chromium' && error.name === 'TimeoutError') recordTimedOutAttempt?.();
    const cleanup = await withDeadline(closeOwned().then(() => 'cleaned up'), phaseMs.cleanup,
      () => new Error(`timed out after ${phaseMs.cleanup}ms`))
      .catch(cleanupError => `cleanup failed: ${cleanupError.message}`);
    const done = completed.length ? completed.join(', ') : 'none';
    const failure = `${name} startup failed during ${PHASE_NAMES[phase]}: ${error.message} `
      + `(completed: ${done}; ${cleanup}${describeLaunchFacts()})`;
    retainLine(`❌ ${failure}`);
    throw new Error(failure, { cause: error });
  }
}
