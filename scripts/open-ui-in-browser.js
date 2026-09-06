#!/usr/bin/env node
// Open the PortOS dashboard in the PortOS-managed Chrome instance.
// Used after setup.sh / update.sh / update.ps1 finish PM2 boot so the user
// lands on the dashboard without having to manually open a tab.
//
// Fail-soft: every failure path logs and exits 0 — never break setup/update
// because Chrome happens to be unreachable.
//
// Drives browserService.navigateToUrlPinned() IN-PROCESS rather than POSTing
// to the running server's `/api/browser/navigate` route. That route sits
// behind the instance-password auth gate (server/services/authGate.js) when
// one is set, and this script — a local maintenance step run by the same OS
// user as the server, never crossing a network trust boundary — has no
// plaintext password to present. Every navigate attempt over HTTP would 401
// forever, silently leaving Chrome on a blank tab even after retrying for the
// full budget below. Calling the service function directly sidesteps the gate
// (there's no HTTP hop to gate) while still applying the same SSRF pinning
// (`assertPublicHttpUrl` + `verifyRemoteIp`) the route applies.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasTailscaleCert } from '../lib/tailscale-https.js';
import { certPaths } from '../lib/certPaths.js';
import { getCliSetupGuide } from './setup-guide.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { navigateToUrlPinned, cdpRequest } from '../server/services/browserService.js';
import { assertPublicHttpUrl } from '../server/lib/safeUrlFetch.js';
import { isBlockedIngestHost } from '../server/lib/catalogValidation.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { dir: CERT_DIR } = certPaths(join(ROOT, 'data'));
const API_PORT = Number(process.env.PORT) || 5555;
const HTTP_LOOPBACK_PORT = Number(process.env.PORTOS_HTTP_PORT) || 5553;
const DEV_UI_PORT = Number(process.env.PORTOS_UI_PORT) || 5554;
const CDP_TIMEOUT_MS = 3_000;

// First-boot startup can take a while: the server binds, opens the DB pool,
// loads the brain index, attaches Socket.IO, then health responds. 90s is
// roomy for a fresh checkout on slow disks; if PortOS still isn't up, the
// user has bigger problems than the auto-open script.
const API_TIMEOUT_MS = 90_000;
// `update.sh`/`update.ps1` do a full `pm2 delete` + `pm2 start` of every
// ecosystem app, including portos-browser — so Chrome is a COLD launch here,
// racing the exact moment CPU/disk are busiest (npm install, client build).
// browser/server.js's own launch-wait is 10s; a single fixed-timeout attempt
// from here regularly lost that race and left Chrome open with no tab
// pointed anywhere. Retry the navigate on a short interval instead of trying
// once.
const NAVIGATE_RETRY_TOTAL_MS = 60_000;
const NAVIGATE_RETRY_INTERVAL_MS = 2_000;
// Mirrors NAVIGATE_SETTLE_MS in server/routes/browser.js — the settle window
// the pin holds open after the first document response so a client-side
// redirect that fires just after load is captured and IP-verified too.
const NAVIGATE_SETTLE_MS = 1_000;
const POLL_INTERVAL_MS = 500;

async function poll(checkFn, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkFn()) return true;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.warn(`⚠️  ${label} didn't respond within ${timeoutMs / 1000}s — skipping auto-open. Check \`pm2 logs portos-server\` for startup errors.`);
  return false;
}

async function ping(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  const ok = await fetchImpl(url, { signal: controller.signal })
    .then(r => r.ok)
    .catch(() => false);
  clearTimeout(timeout);
  return ok;
}

/**
 * Fetch open CDP pages from /json/list, throwing if CDP is unreachable or returns an error.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<Array<{id: string, url: string, title?: string, type?: string}>>}
 */
export async function getOpenCdpPages({ timeoutMs = CDP_TIMEOUT_MS } = {}) {
  const response = await cdpRequest('/json/list', { timeout: timeoutMs });
  if (!response?.ok) {
    throw new Error(`CDP /json/list failed (${response?.status || 'unknown'})`);
  }
  const data = await response.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

/**
 * Test whether a CDP target page represents the PortOS app.
 * Matches against targetUrl (if provided), loopback addresses (localhost, 127.0.0.1, ::1)
 * on PortOS ports, Tailscale domains (*.ts.net) on PortOS ports, or page title starting
 * with PortOS on a PortOS port.
 * @param {object} page
 * @param {object} [opts]
 * @param {string} [opts.targetUrl]
 * @param {number} [opts.apiPort]
 * @param {number} [opts.loopbackPort]
 * @param {number} [opts.devUiPort]
 * @returns {boolean}
 */
export function isPortOsPage(page, {
  targetUrl,
  apiPort = API_PORT,
  loopbackPort = HTTP_LOOPBACK_PORT,
  devUiPort = DEV_UI_PORT,
} = {}) {
  if (!page || (page.type && page.type !== 'page')) return false;
  const rawUrl = page.url;
  if (!rawUrl || typeof rawUrl !== 'string') return false;

  let pageUrl;
  try {
    pageUrl = new URL(rawUrl);
  } catch {
    return false;
  }

  // Exact origin or hostname+port match against targetUrl if provided
  if (targetUrl) {
    try {
      const target = new URL(targetUrl);
      if (pageUrl.origin === target.origin) return true;
      const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80');
      const pagePort = pageUrl.port || (pageUrl.protocol === 'https:' ? '443' : '80');
      if (pageUrl.hostname.toLowerCase() === target.hostname.toLowerCase() && pagePort === targetPort) {
        return true;
      }
    } catch {}
  }

  const validPorts = new Set([
    String(apiPort),
    String(loopbackPort),
    String(devUiPort),
  ]);

  const pagePort = pageUrl.port || (pageUrl.protocol === 'https:' ? '443' : pageUrl.protocol === 'http:' ? '80' : '');
  const isPortosPort = validPorts.has(pagePort);
  if (!isPortosPort) return false;

  const hostname = pageUrl.hostname.toLowerCase();
  const isLoopbackHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  const isTailscaleHost = hostname.endsWith('.ts.net');

  if (isLoopbackHost || isTailscaleHost) {
    return true;
  }

  // Also match if page title indicates PortOS when running on a PortOS port (e.g. LAN IP access)
  const title = (page.title || '').trim();
  if (title === 'PortOS' || title.startsWith('PortOS:') || title.startsWith('PortOS -')) {
    return true;
  }

  return false;
}

/**
 * Find an existing tab in a list of CDP targets that has the PortOS app open.
 * @param {Array<object>} pages
 * @param {object} [opts]
 * @returns {object|null}
 */
export function findExistingPortOsTab(pages, opts = {}) {
  if (!Array.isArray(pages)) return null;
  return pages.find((page) => isPortOsPage(page, opts)) || null;
}

/**
 * Call `navigateFn` on a fixed interval until it resolves or the overall
 * budget expires. A single early failure (Chrome still cold-launching, CDP
 * not listening yet) must not be treated as final — the caller only gets one
 * shot at auto-opening the dashboard per restart, so this has to outlast the
 * slowest realistic Chrome cold-start rather than the fastest.
 * @param {object} opts
 * @param {() => Promise<unknown>} opts.navigateFn - performs one navigate attempt, throwing on failure
 * @param {number} opts.totalTimeoutMs - overall retry budget
 * @param {number} opts.intervalMs - delay between attempts
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<{ok: boolean, page?: unknown, error?: string}>}
 */
export async function navigateWithRetry({
  navigateFn,
  totalTimeoutMs,
  intervalMs,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
}) {
  const deadline = Date.now() + totalTimeoutMs;
  let lastError = new Error('navigate was never attempted');
  while (true) {
    const page = await navigateFn().catch(err => { lastError = err; return undefined; });
    if (page !== undefined) return { ok: true, page };

    if (Date.now() + intervalMs >= deadline) return { ok: false, error: lastError?.message || 'unknown error' };
    await sleep(intervalMs);
  }
}

/**
 * Coordinate opening PortOS in the CDP browser: checks if an existing PortOS tab
 * is already open, and only navigates to open a new tab when none is found.
 * @param {object} [opts]
 * @param {string} opts.targetUrl
 * @param {number} [opts.apiPort]
 * @param {number} [opts.loopbackPort]
 * @param {number} [opts.devUiPort]
 * @param {() => Promise<Array<object>>} [opts.getPagesFn]
 * @param {(url: string) => Promise<unknown>} [opts.navigatePinnedFn]
 * @param {number} [opts.totalTimeoutMs]
 * @param {number} [opts.intervalMs]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<{ok: boolean, page?: {alreadyOpen: boolean, tab: object}, error?: string}>}
 */
export async function openPortOsUi({
  targetUrl,
  apiPort = API_PORT,
  loopbackPort = HTTP_LOOPBACK_PORT,
  devUiPort = DEV_UI_PORT,
  getPagesFn = getOpenCdpPages,
  navigatePinnedFn = (url) => navigateToUrlPinned(url, {
    verifyRemoteIp: (ip) => !isBlockedIngestHost(ip),
    settleMs: NAVIGATE_SETTLE_MS,
  }),
  totalTimeoutMs = NAVIGATE_RETRY_TOTAL_MS,
  intervalMs = NAVIGATE_RETRY_INTERVAL_MS,
  sleep,
} = {}) {
  return navigateWithRetry({
    navigateFn: async () => {
      const pages = await getPagesFn();
      const existing = findExistingPortOsTab(pages, {
        targetUrl,
        apiPort,
        loopbackPort,
        devUiPort,
      });
      if (existing) {
        return { alreadyOpen: true, tab: existing };
      }
      const page = await navigatePinnedFn(targetUrl);
      return { alreadyOpen: false, tab: page };
    },
    totalTimeoutMs,
    intervalMs,
    sleep,
  });
}

async function main() {
  // Share the same cert predicate the server's HTTPS gate uses (file presence
  // AND PEM parseability). A presence-only check would route us to :5553 even
  // when corrupt PEMs forced the server back to plain HTTP-on-:5555, so the
  // poll would time out on a port the server never bound.
  const HTTPS_MODE = hasTailscaleCert(CERT_DIR);

  // When HTTPS is on, :5555 speaks TLS only — plain http:// requests hit a TLS
  // mismatch and time out. The loopback HTTP mirror on :5553 serves the same
  // app and skips the cert warning, so startup polling always stays local even
  // when the final browser destination is the trusted MagicDNS origin.
  const LOCAL_BASE = HTTPS_MODE
    ? `http://localhost:${HTTP_LOOPBACK_PORT}`
    : `http://localhost:${API_PORT}`;
  // Poll through loopback so certificate trust never delays startup detection,
  // but land the browser on the real MagicDNS origin when a trusted Tailscale
  // cert exists. That is the URL remote devices use and the secure context where
  // microphone/browser APIs work; opening the mirror hid this final setup step.
  // The shared walkthrough also proves that Tailscale is currently connected and
  // the cert matches its current MagicDNS name; a stale cert alone must not send
  // the managed browser to an unreachable host.
  const setupGuide = await getCliSetupGuide({ assumeActive: HTTPS_MODE });
  const TARGET_URL = setupGuide.trustedUrl || LOCAL_BASE;

  const apiHealthUrl = `${LOCAL_BASE}/api/system/health`;

  const apiReady = await poll(() => ping(apiHealthUrl), 'PortOS API', API_TIMEOUT_MS);
  if (!apiReady) process.exit(0);

  // Fail-soft: a target URL this script itself derived should never trip the
  // SSRF guard, but if it somehow does, don't burn the retry budget re-trying
  // a URL that will never pass.
  const unsafeReason = await assertPublicHttpUrl(TARGET_URL).then(() => null).catch(err => err.message || 'unsafe URL');
  if (unsafeReason) {
    console.warn(`⚠️  Refusing to auto-open ${TARGET_URL} (${unsafeReason}) — open it manually.`);
    process.exit(0);
  }

  const result = await openPortOsUi({
    targetUrl: TARGET_URL,
    apiPort: API_PORT,
    loopbackPort: HTTP_LOOPBACK_PORT,
    devUiPort: DEV_UI_PORT,
  });

  if (!result.ok) {
    console.warn(`⚠️  Could not auto-open the dashboard within ${NAVIGATE_RETRY_TOTAL_MS / 1000}s (${result.error}) — open it manually: ${TARGET_URL}`);
    process.exit(0);
  }

  if (result.page?.alreadyOpen) {
    console.log(`🌐 PortOS is already open in browser (${result.page.tab.url}) — skipping auto-open`);
  } else {
    console.log(`🌐 Opened ${TARGET_URL} in PortOS browser`);
  }
  process.exit(0);
}

if (isDirectlyInvoked(import.meta.url)) await main();
