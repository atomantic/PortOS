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
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BROWSER_FIXTURE_STARTUP_MS = 60000;

export const BROWSER_FIXTURE_PHASE_MS = Object.freeze({
  vite: 10000,
  chromium: 15000,
  warmup: 25000,
  cleanup: 5000,
});

const PHASE_NAMES = { vite: 'Vite server start', chromium: 'Chromium launch', warmup: 'first page warmup' };

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
 * @param {object} options.chromium - playwright-core's `chromium`
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
  const runPhase = async (key, work) => {
    phase = key;
    const started = Date.now();
    const value = await withDeadline(Promise.resolve().then(work), phaseMs[key],
      () => new Error(`timed out after ${phaseMs[key]}ms`));
    completed.push(`${PHASE_NAMES[key]} ${Date.now() - started}ms`);
    return value;
  };

  try {
    const server = await runPhase('vite', async () => {
      const config = viteConfig(temp);
      if (!config.optimizeDeps?.entries?.length) {
        throw new Error('viteConfig must set optimizeDeps.entries to the rendered source files, or Vite scans the whole app');
      }
      const vite = await createServer(config);
      own(() => vite.close());
      await vite.listen();
      return vite;
    });
    const origin = server.resolvedUrls.local[0];
    const browser = await runPhase('chromium', async () => {
      // Playwright's own launch timeout kills the child it spawned; the phase
      // deadline above is the backstop if that kill itself hangs.
      const launched = await chromium.launch({
        headless: true,
        timeout: phaseMs.chromium,
        ...launchOptions,
        env: { ...process.env, ...launchOptions.env, TMPDIR: temp, TMP: temp, TEMP: temp },
      });
      own(() => launched.close());
      return launched;
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
