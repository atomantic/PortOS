import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// playwright-core is installed per workspace, so resolve from each workspace (and the root), not from scripts/lib.
const PLAYWRIGHT_RESOLVE_ROOTS = Object.freeze(['server', 'client', ''].map((dir) => join(REPO_ROOT, dir, 'package.json')));

/**
 * Where the browser suites look for a Chrome after `CHROME_PATH` and
 * Playwright's bundled Chromium: the macOS app and the Linux package paths.
 * One list for the client and server suites, the pregate probe, the test memo
 * and `scripts/ci-warm-test-chrome.sh` (#12293, #12315). It lives outside
 * `server/lib` so client tests can import it without tripping the
 * browser-safe-imports guard on that tree.
 */
const TEST_CHROME_CANDIDATES = Object.freeze([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]);

/**
 * Playwright's bundled Chromium, when playwright-core is installed and a browser was downloaded; null otherwise.
 * Keeps walking workspace anchors past an install whose browser is missing, so a
 * downloaded browser in a later workspace is still found. When none exists on disk,
 * returns the first resolved path (callers check existence themselves).
 */
export function bundledChromium(anchors = PLAYWRIGHT_RESOLVE_ROOTS, exists = existsSync) {
  let firstResolved = null;
  for (const anchor of anchors) {
    let path;
    try { path = createRequire(anchor)('playwright-core').chromium.executablePath(); } catch { continue; }
    if (!path) continue;
    if (exists(path)) return path;
    firstResolved ??= path;
  }
  return firstResolved;
}

/**
 * The Chrome binary a browser suite would launch on this machine, or null:
 * `env.CHROME_PATH`, then Playwright's bundled Chromium, then the macOS app
 * and the Linux package paths, the first that exists.
 */
export function resolveTestChrome(env = process.env, { exists = existsSync, bundled = bundledChromium } = {}) {
  return [env.CHROME_PATH, bundled(), ...TEST_CHROME_CANDIDATES].find((path) => path && exists(path)) ?? null;
}
