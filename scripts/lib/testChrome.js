import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

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

/** Playwright's bundled Chromium, when playwright-core is installed and a browser was downloaded; null otherwise. */
function bundledChromium() {
  try { return createRequire(import.meta.url)('playwright-core').chromium.executablePath(); } catch { return null; }
}

/**
 * The Chrome binary a browser suite would launch on this machine, or null:
 * `env.CHROME_PATH`, then Playwright's bundled Chromium, then the macOS app
 * and the Linux package paths, the first that exists.
 */
export function resolveTestChrome(env = process.env, { exists = existsSync, bundled = bundledChromium } = {}) {
  return [env.CHROME_PATH, bundled(), ...TEST_CHROME_CANDIDATES].find((path) => path && exists(path)) ?? null;
}
