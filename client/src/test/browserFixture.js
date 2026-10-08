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
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BROWSER_FIXTURE_STARTUP_MS = 60000;

export const BROWSER_FIXTURE_PHASE_MS = Object.freeze({
  vite: 5000,
  chromium: 24000,
  warmup: 25000,
  cleanup: 5000,
});

const PHASE_NAMES = { vite: 'Vite server start', chromium: 'Chromium launch', warmup: 'first page warmup' };

const timeoutError = ms => Object.assign(new Error(`timed out after ${ms}ms`), { name: 'TimeoutError' });

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
 * @returns {Promise<{ origin: string, browser: object, server: object, temp: string, close: () => Promise<void> }>}
 */
export async function startBrowserFixture({
  name, createServer, viteConfig, chromium, launchOptions = {}, warmup, phaseMs = BROWSER_FIXTURE_PHASE_MS,
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
  // One Chromium process. A browser that arrives after its attempt was
  // abandoned is closed at once; one that arrives in time joins `own`, which
  // closes it at once if the fixture has failed meanwhile.
  const launchOnce = (timeout) => {
    let abandoned = false;
    const launching = chromium.launch({
      headless: true,
      timeout,
      ...launchOptions,
      env: { ...process.env, ...launchOptions.env, TMPDIR: temp, TMP: temp, TEMP: temp },
    }).then((launched) => {
      if (abandoned) launched.close().catch(() => {});
      else own(() => launched.close());
      return launched;
    });
    return { launching, abandon: () => { abandoned = true; } };
  };

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
    console.log(`🧪 ${name} browser fixture ready (${completed.join(', ')})`);
    return { origin, browser, server, temp, close: closeOwned };
  } catch (error) {
    failed = true;
    const cleanup = await withDeadline(closeOwned().then(() => 'cleaned up'), phaseMs.cleanup,
      () => new Error(`timed out after ${phaseMs.cleanup}ms`))
      .catch(cleanupError => `cleanup failed: ${cleanupError.message}`);
    const done = completed.length ? completed.join(', ') : 'none';
    throw new Error(`${name} startup failed during ${PHASE_NAMES[phase]}: ${error.message} `
      + `(completed: ${done}; ${cleanup})`, { cause: error });
  }
}
