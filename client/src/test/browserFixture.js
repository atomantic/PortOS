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
 * page faults, under heavy I/O pressure. Those samples do not establish a
 * causal disk fault. The existing mitigation gives the launch two attempts: a
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
 *
 * Teardown stalls too (#10830): a graceful close of a system Chrome took 4–5s
 * on an idle macOS host and 6–10s on a busy one, past the cleanup budget,
 * which turned it into an error (#10791) while the browser and its profile
 * directory stayed behind. Playwright's own kill of the same process takes
 * well under a second and removes the profile, so it gets most of the budget. A `Browser` from `launch()` exposes no process, so a real launch
 * goes through Playwright's process-backed `launchServer()` and connects to
 * it: the fixture keeps the server, closes gracefully first, then kills only
 * that server's own process, and reports success only on its exit status. A
 * `{ launch }` stand-in — the CDP adapter attaching to an external browser
 * among them — keeps only `close()`, which never terminates what it attached
 * to.
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

// Linux-only, bounded discovery: at most 64 worker threads, 256 child
// identities and 4096 bytes per read. An incomplete census is unavailable,
// never evidence that a unique child was found. No raw proc text is reported.
const readPrefix = (path) => {
  const fd = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(4097);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 4096) throw new Error('process observation limit');
    return bytes.subarray(0, length).toString();
  } finally { closeSync(fd); }
};
const listDir = (path) => {
  const dir = opendirSync(path);
  const names = [];
  try {
    let entry;
    while ((entry = dir.readSync())) {
      if (names.length === 64) throw new Error('process observation limit');
      names.push(entry.name);
    }
  } finally { dir.closeSync(); }
  return names;
};
const BROWSER_PROCESS_NAME = /^(chrome|chromium|google-chrome|headless_shell|chrome-headless)/;

// Keeping the proc directory open binds subsequent reads to that process,
// even if it exits and its numeric PID is recycled before the sample ends.
// The kernel then refuses reads rather than following the replacement PID.
const openChild = (pid) => {
  const fd = openSync(`/proc/${pid}`, 'r');
  return {
    read: suffix => readPrefix(`/proc/self/fd/${fd}/${suffix}`),
    list: suffix => listDir(`/proc/self/fd/${fd}/${suffix}`),
    close: () => closeSync(fd),
  };
};
const childIdentity = (text, workerPid) => {
  const end = text.lastIndexOf(')');
  if (end < 0) return null;
  const fields = text.slice(end + 2).trim().split(/\s+/);
  const name = text.slice(text.indexOf('(') + 1, end);
  // Field 22 (index 19 after comm) is the process start time in clock ticks.
  if (fields[1] !== String(workerPid) || !/^\d+$/.test(fields[19] ?? '')) return null;
  return { browser: BROWSER_PROCESS_NAME.test(name), started: fields[19] };
};

/** Observe only a newly discovered direct browser child, with a stable identity. */
export function _observeOwnedBrowserLaunch({
  platform = process.platform, workerPid = process.pid, read = readPrefix, list = listDir,
  processFacts = _testChromeProcessFacts, open = openChild,
} = {}) {
  if (platform !== 'linux') return () => 'os=unsupported';
  const browserChildren = () => {
    const browsers = new Map();
    const pids = new Set();
    const tids = list(`/proc/${workerPid}/task`).filter(name => /^[1-9]\d*$/.test(name));
    if (!tids.length || tids.length > 64) throw new Error('incomplete thread census');
    for (const tid of tids) {
      const children = read(`/proc/${workerPid}/task/${tid}/children`);
      if (children.length > 4096) throw new Error('process observation limit');
      for (const pid of children.trim().split(/\s+/).filter(Boolean)) {
        if (!/^[1-9]\d*$/.test(pid)) throw new Error('invalid child identity');
        pids.add(pid);
        if (pids.size > 256) throw new Error('process observation limit');
      }
    }
    for (const pid of pids) {
      const child = open(pid);
      try {
        const identity = childIdentity(child.read('stat'), workerPid);
        if (!identity) throw new Error('child ownership unavailable');
        if (identity.browser) browsers.set(pid, identity.started);
      } finally { child.close(); }
    }
    return browsers;
  };
  let earlier;
  try { earlier = browserChildren(); } catch { earlier = null; }
  return () => {
    if (!earlier) return 'browserChildren=unavailable';
    try {
      const fresh = [...browserChildren()].filter(([pid]) => !earlier.has(pid));
      if (fresh.length !== 1) return `browserChildren=${fresh.length}`;
      const [pid, started] = fresh[0];
      const child = open(pid);
      try {
        const identity = childIdentity(child.read('stat'), workerPid);
        if (!identity?.browser || identity.started !== started) return 'browserChildren=unavailable';
        const prefix = `/proc/${pid}/`;
        const facts = processFacts({ pid: Number(pid), exitCode: null, signalCode: null }, {
          platform, workerPid,
          read: path => path.startsWith(prefix) ? child.read(path.slice(prefix.length)) : read(path),
          threads: path => child.list(path.slice(prefix.length)),
        });
        return `browserChildren=1 ${facts}`;
      } finally { child.close(); }
    } catch { return 'browserChildren=unavailable'; }
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

// Resolves to null once the work succeeds within `ms`, or else to why it did not.
const failureWithin = (work, ms) => withDeadline(
  Promise.resolve().then(work).then(() => null, error => `failed: ${error.message}`),
  ms, () => timeoutError(ms),
).catch(() => `stalled after ${ms}ms`);

/**
 * Closes a browser server the fixture launched, inside `budgetMs`: a graceful
 * close for 30% of it, then the server's own kill for 60%, which signals only
 * the process Playwright spawned (and its process group) and resolves once
 * that process closed and its profile was removed. Each step counts only with
 * the child's exit status in hand, never because a signal was sent; when
 * neither produces one, the close rejects, saying whether the process had
 * exited — the kill then waits on Playwright's own stdio and profile cleanup.
 */
const reapOwnedBrowser = async (server, budgetMs) => {
  const child = server.process();
  const exitStatus = () => child?.exitCode ?? child?.signalCode ?? null;
  const confirmed = failure => failure ?? (exitStatus() === null ? 'returned without an exit status' : null);
  const closeFailure = confirmed(await failureWithin(() => server.close(), Math.floor(budgetMs * 0.3)));
  if (!closeFailure) return;
  const killFailure = confirmed(await failureWithin(() => server.kill(), Math.floor(budgetMs * 0.6)));
  if (!killFailure) return;
  const exit = exitStatus();
  const state = exit !== null ? ` (process exited with ${exit})` : killFailure.endsWith('exit status') ? '' : ' (no exit status)';
  throw new Error(`browser close ${closeFailure}, then its kill ${killFailure}${state}`);
};

/**
 * @param {object} options
 * @param {string} options.name - fixture label used in errors and the temp-dir prefix
 * @param {Function} options.createServer - vite's `createServer`
 * @param {(temp: string) => object} options.viteConfig - inline Vite config; `temp` is the fixture's private temp dir
 * @param {object} options.chromium - playwright-core's `chromium`, whose `launchServer` gives the fixture the browser
 *   process to reap; or any `{ launch }` stand-in (e.g. one wrapping `connectOverCDP`), which it only ever `close()`s
 * @param {object} [options.launchOptions] - extra launch options (executablePath, args, …)
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
  // Every closer runs under its own cleanup deadline, so one stalled teardown
  // neither starves another nor outlives the `afterAll` hook (#10791).
  const closeBounded = ({ closer, label }) => withDeadline(Promise.resolve().then(closer), phaseMs.cleanup,
    () => new Error(`${label} close stalled after ${phaseMs.cleanup}ms`));
  // Nothing awaits a resource closed after the hook that acquired it gave up,
  // so a failure to close it is reported here rather than lost.
  const discard = owned => closeBounded(owned).catch((error) => {
    const line = `❌ ${name} browser fixture could not close a late ${owned.label}: ${error.message}`;
    console.error(line);
    retainLine(line);
  });
  // A resource acquired after its phase already failed is closed at once
  // instead of leaking past the hook that abandoned it.
  const own = (closer, label) => {
    if (failed) discard({ closer, label });
    else closers.push({ closer, label });
  };
  // Closers run concurrently, and the temp dir is removed whether or not one
  // stalled.
  const closeOwned = async () => {
    const errors = [];
    await Promise.all(closers.splice(0).reverse().map(owned => closeBounded(owned)
      .catch(error => errors.push(error.message))));
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
  // A real launch: Playwright's server owns the browser process and the
  // fixture's browser is its client, so closing reaps that process. A
  // stand-in without `launchServer` — an attached CDP browser above all —
  // keeps only its own `close()`.
  const ownsProcess = typeof chromium.launchServer === 'function';
  const launchBrowser = async (options, isAbandoned) => {
    if (!ownsProcess) {
      const browser = await chromium.launch(options);
      return { browser, closer: () => browser.close() };
    }
    const server = await chromium.launchServer(options);
    const closer = () => reapOwnedBrowser(server, phaseMs.cleanup);
    // Nobody will use a browser startup already gave up on: skip connecting.
    if (isAbandoned()) return { closer };
    try {
      return { browser: await chromium.connect(server.wsEndpoint(), { timeout: options.timeout }), closer };
    } catch (error) {
      discard({ closer, label: 'browser' });
      throw error;
    }
  };
  // Facts of every launch attempt that timed out, in attempt order, and the
  // recorder of the attempt in flight.
  const launchFacts = [];
  let recordTimedOutAttempt;
  // One Chromium process. A browser that arrives after its attempt was
  // abandoned is closed at once, under the same bounded cleanup; one that
  // arrives in time joins `own`, which closes it at once if the fixture has
  // failed meanwhile. Shortly before its
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
    const launching = launchBrowser({
      headless: true,
      timeout,
      ...launchOptions,
      env: { ...process.env, ...launchOptions.env, TMPDIR: temp, TMP: temp, TEMP: temp },
    }, () => abandoned || failed).then(({ browser, closer }) => {
      settle();
      if (abandoned) discard({ closer, label: 'browser' });
      else own(closer, 'browser');
      return browser;
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
      own(() => vite.close(), 'Vite server');
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
