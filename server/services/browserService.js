/**
 * Browser Service - manages the portos-browser CDP instance
 * Communicates with the portos-browser process (port 5557 health, port 5556 CDP)
 * Stores config in data/browser-config.json
 */

import { readdir, stat, unlink } from 'fs/promises';
import { join, basename, resolve, extname } from 'path';
import { EventEmitter } from 'events';
import { ensureDir, safeJSONParse, PATHS, tryReadFile, atomicWrite, sleep } from '../lib/fileUtils.js';
import { normalizeBrowserConfig } from '../lib/browserConfig.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { readResponseJson } from '../lib/readResponseJson.js';
import { execPm2 } from './pm2.js';

const PM2_SETTLE_MS = 1500;
const HEALTH_TIMEOUT_MS = 3000;
const NAVIGATE_TIMEOUT_MS = 10000;
const LOGS_TIMEOUT_MS = 5000;
const CDP_DEFAULT_TIMEOUT_MS = 10000;
const CDP_EVALUATE_TIMEOUT_MS = 60000;

// Auth/login redirect detection across providers (Microsoft, Okta, Google, generic)
const AUTH_PATTERNS = ['login.microsoftonline.com', 'okta.com', 'login.live.com', 'accounts.google.com', 'Sign in'];

const CONFIG_FILE = join(PATHS.data, 'browser-config.json');
const ECOSYSTEM_FILE = join(PATHS.root, 'ecosystem.config.cjs');

export const browserEvents = new EventEmitter();

const DEFAULT_PROFILE_DIR = PATHS.browserProfile;
const DEFAULT_DOWNLOAD_DIR = PATHS.browserDownloads;

const DEFAULT_CONFIG = {
  cdpPort: 5556,
  cdpHost: process.env.CDP_HOST || '127.0.0.1',
  healthPort: 5557,
  autoConnect: true,
  // Default HEADED — the managed CDP browser is meant to be visible (see
  // browser/server.js, which already launches headed unless `headless === true`).
  // Keeping this fallback headed matches that and the shipped seed.
  headless: false,
  userDataDir: DEFAULT_PROFILE_DIR,
  downloadDir: DEFAULT_DOWNLOAD_DIR
};

let cachedConfig = null;
let cachedConfigMtimeMs = null;

// ---------- Config persistence ----------

async function getConfigMtimeMs() {
  const info = await stat(CONFIG_FILE).catch(() => null);
  return info?.isFile() ? info.mtimeMs : null;
}

export async function loadConfig() {
  const mtimeMs = await getConfigMtimeMs();
  if (cachedConfig && cachedConfigMtimeMs === mtimeMs) return cachedConfig;
  const raw = await tryReadFile(CONFIG_FILE);
  const parsed = safeJSONParse(raw, null);
  cachedConfig = normalizeBrowserConfig(parsed ? { ...DEFAULT_CONFIG, ...parsed } : { ...DEFAULT_CONFIG });
  cachedConfigMtimeMs = mtimeMs;
  return cachedConfig;
}

export async function saveConfig(config) {
  await ensureDir(PATHS.data);
  cachedConfig = normalizeBrowserConfig({ ...DEFAULT_CONFIG, ...config });
  await atomicWrite(CONFIG_FILE, cachedConfig);
  cachedConfigMtimeMs = await getConfigMtimeMs();
  browserEvents.emit('config:changed', cachedConfig);
  return cachedConfig;
}

export async function getConfig() {
  return loadConfig();
}

export async function updateConfig(updates) {
  const current = await loadConfig();
  return saveConfig({ ...current, ...updates });
}

// ---------- Status / Health ----------

export async function getHealthStatus() {
  const config = await loadConfig();
  // Bind-all addresses are not connectable; use loopback instead
  const connectHost = config.cdpHost === '0.0.0.0' ? '127.0.0.1'
    : config.cdpHost === '::' ? '[::1]'
    : config.cdpHost;
  const healthUrl = `http://${connectHost}:${config.healthPort}/health`;

  const response = await fetchWithTimeout(healthUrl, {}, HEALTH_TIMEOUT_MS).catch(() => null);

  if (!response || !response.ok) {
    return {
      connected: false,
      processRunning: false,
      cdpPort: config.cdpPort,
      cdpHost: config.cdpHost,
      healthPort: config.healthPort,
      cdpEndpoint: `ws://${config.cdpHost}:${config.cdpPort}`,
      error: response ? `Health check returned ${response.status}` : 'Health check unreachable'
    };
  }

  const data = await readResponseJson(response);
  return {
    connected: data.status === 'healthy',
    processRunning: true,
    cdpPort: data.cdpPort || config.cdpPort,
    cdpHost: data.cdpHost || config.cdpHost,
    healthPort: config.healthPort,
    cdpEndpoint: data.cdpEndpoint || `ws://${config.cdpHost}:${config.cdpPort}`,
    headless: data.headless ?? config.headless,
    status: data.status
  };
}

// ---------- PM2 process management ----------

async function pm2Action(action, args) {
  console.log(`🌐 Browser PM2 ${action}: portos-browser`);
  // execPm2 runs `node pm2/bin/pm2` directly. Resolving bare `pm2` through a
  // shell picks up pm2.cmd on Windows, and that cmd.exe hop opens a console
  // window out of PortOS's console-less PM2 fork — see docs/WINDOWS_CONSOLE.md.
  await execPm2([action, ...args]);
  console.log(`✅ Browser PM2 ${action} complete`);

  // Give PM2 a moment to settle
  await sleep(PM2_SETTLE_MS);

  const status = await getHealthStatus();
  browserEvents.emit('status:changed', status);
  return status;
}

export async function launchBrowser() {
  // Use ecosystem file so PM2 has the full process config even after pm2 flush/delete
  return pm2Action('start', [ECOSYSTEM_FILE, '--only', 'portos-browser']);
}

export async function stopBrowser() {
  return pm2Action('stop', ['portos-browser']);
}

export async function restartBrowser() {
  return pm2Action('restart', ['portos-browser']);
}

// ---------- PM2 status (process-level) ----------

export async function getProcessStatus() {
  const { stdout } = await execPm2(['jlist']);
  const processes = safeJSONParse(stdout, [], { allowArray: true });
  const browserProc = processes.find(p => p.name === 'portos-browser');

  if (!browserProc) {
    return { exists: false, status: 'not_found', pm2_id: null };
  }

  return {
    exists: true,
    status: browserProc.pm2_env?.status || 'unknown',
    pm2_id: browserProc.pm_id,
    pid: browserProc.pid,
    memory: browserProc.monit?.memory || 0,
    cpu: browserProc.monit?.cpu || 0,
    uptime: browserProc.pm2_env?.pm_uptime || null,
    restarts: browserProc.pm2_env?.restart_time || 0,
    unstableRestarts: browserProc.pm2_env?.unstable_restarts || 0
  };
}

// ---------- Logs ----------

export async function getRecentLogs(lines = 50) {
  const { stdout, stderr } = await execPm2(['logs', 'portos-browser', '--nostream', '--lines', String(lines)], {
    timeout: LOGS_TIMEOUT_MS
  }).catch(() => ({ stdout: '', stderr: '' }));

  return { stdout: stdout || '', stderr: stderr || '' };
}

// ---------- CDP shared helpers ----------

// Bind-all addresses (0.0.0.0, ::) are not connectable — fall back to IPv4 loopback
async function getCdpConnectHost() {
  const config = await loadConfig();
  const host = (config.cdpHost === '0.0.0.0' || config.cdpHost === '::') ? '127.0.0.1' : config.cdpHost;
  return { host, port: config.cdpPort };
}

export async function cdpRequest(path, options = {}) {
  const { host, port } = await getCdpConnectHost();
  const url = `http://${host}:${port}${path}`;
  const { timeout, ...rest } = options;
  return fetchWithTimeout(url, rest, timeout || CDP_DEFAULT_TIMEOUT_MS);
}

// Returns raw CDP page objects (includes webSocketDebuggerUrl, unlike getOpenPages)
export async function listCdpPages() {
  const response = await cdpRequest('/json/list', { timeout: HEALTH_TIMEOUT_MS }).catch(() => null);
  if (!response || !response.ok) return [];
  return readResponseJson(response, { fallback: [] });
}

export async function findOrOpenPage(targetUrl) {
  const pages = await listCdpPages();
  const existing = pages.find(p => p.url?.includes(new URL(targetUrl).hostname));
  if (existing) return existing;
  const response = await cdpRequest(`/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' });
  if (!response.ok) return null;
  // Preserve the null-on-failure contract: a malformed body stays null, not {}.
  return readResponseJson(response, { fallback: null, emptyValue: null });
}

export function isAuthPage(page) {
  const url = page?.url || '';
  const title = page?.title || '';
  return AUTH_PATTERNS.some(p => url.includes(p) || title.includes(p));
}

export async function evaluateOnPage(page, expression, { timeout = CDP_EVALUATE_TIMEOUT_MS } = {}) {
  const wsUrl = page?.webSocketDebuggerUrl;
  if (!wsUrl) return null;

  const { default: WebSocket } = await import('ws');

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); resolve(null); }, timeout);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      }));
    });

    ws.on('message', (data) => {
      const msg = safeJSONParse(data.toString(), null, { context: 'cdp-ws' });
      if (!msg || msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error || msg.result?.exceptionDetails) return resolve(null);
      resolve(msg.result?.result?.value ?? null);
    });

    ws.on('error', () => { clearTimeout(timer); ws.close(); resolve(null); });
  });
}

// ---------- CDP navigation ----------

export async function navigateToUrl(url) {
  const response = await cdpRequest(`/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
    timeout: NAVIGATE_TIMEOUT_MS
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`CDP navigate failed (${response.status}): ${text}`);
  }

  // A successful CDP /json/new always returns a target with an id; a malformed
  // 200 body must fail like a !ok navigate rather than return a truthy tab with
  // undefined id/url that a caller mistakes for a successful navigation.
  const page = await readResponseJson(response, { fallback: null, emptyValue: null });
  if (!page?.id) {
    throw new Error(`CDP navigate returned a malformed response for ${url}`);
  }
  console.log(`🌐 Opened ${url} in CDP browser (tab ${page.id})`);
  return { id: page.id, title: page.title || '(loading)', url: page.url, type: page.type };
}

// ---------- CDP pinned navigation (SSRF: verify Chrome's ACTUAL connect IP) ----------

// `serviceWorkerResponseSource` values that mean the service worker answered
// from a local store instead of dialing out: its own Cache Storage, the HTTP
// cache, or the worker's synthesized fallback response. `'network'` — the SW
// passed the request THROUGH — is deliberately absent: that hop did make a
// connection, it just isn't annotated with the peer address.
const NO_NETWORK_SW_SOURCES = new Set(['cache-storage', 'http-cache', 'fallback-code']);

// Hostname of a URL, or null when it isn't parseable. Used wherever the only
// address signal available is the URL itself (WebSockets and connectionless
// hops), never as a substitute for a verified peer IP.
const hostOf = (raw) => {
  if (typeof raw !== 'string') return null;
  try { return new URL(raw).hostname; } catch { return null; }
};

// One main-frame hop from a CDP `Network.Response` (a `responseReceived`
// payload or the `redirectResponse` riding on the next request).
const toHop = (r, requestId) => ({
  requestId,
  url: r.url || null,
  remoteIPAddress: r.remoteIPAddress || '',
  status: r.status ?? null,
  fromServiceWorker: r.fromServiceWorker === true,
  fromDiskCache: r.fromDiskCache === true,
  fromPrefetchCache: r.fromPrefetchCache === true,
  serviceWorkerResponseSource: r.serviceWorkerResponseSource || null,
});

// True when Chrome explicitly reported that this hop was served WITHOUT opening
// a connection (disk cache, prefetch cache, or a service worker answering from
// its own store). Such a hop has no peer IP to pin because there is no peer —
// distinct from an empty `remoteIPAddress` with no explanation, which stays a
// refusal. Exported for testing.
export function hopMadeNoConnection(hop) {
  if (!hop) return false;
  return hop.fromDiskCache === true
    || hop.fromPrefetchCache === true
    || NO_NETWORK_SW_SOURCES.has(hop.serviceWorkerResponseSource);
}

// True when a `Network.loadingFailed` describes a load Chrome ABANDONED rather
// than one that failed against a peer. Chrome 150 flags a superseded top-level
// navigation with `canceled: true` and `net::ERR_ABORTED`; either signal alone
// is accepted so a Chrome that reports only one of them still classifies. Every
// other error kind is a real connection outcome we could not pin. Exported for
// testing.
export function navigationWasCanceled(params) {
  return params?.canceled === true || params?.errorText === 'net::ERR_ABORTED';
}

// Human-readable cause for an empty-IP refusal, so the next occurrence is
// diagnosable from the thrown message without a manual CDP replay.
const describeHopDelivery = (hop) => `no remoteIPAddress; fromServiceWorker=${hop.fromServiceWorker === true}`
  + `, fromDiskCache=${hop.fromDiskCache === true}`
  + `, fromPrefetchCache=${hop.fromPrefetchCache === true}`
  + `, serviceWorkerResponseSource=${hop.serviceWorkerResponseSource || 'none'}`;

/**
 * Extract EVERY main-frame document network hop (each top-level navigation's
 * initial request + every HTTP redirect + final response) from a captured stream
 * of CDP Network events, each annotated with the *actual* IP Chrome connected to
 * (`remoteIPAddress`).
 *
 * CDP marks a main-document load with `requestId === loaderId`; redirects reuse
 * that requestId and arrive as a `redirectResponse` on the following
 * `Network.requestWillBeSent`, and the final hop lands as a
 * `Network.responseReceived` with the same requestId. A page can start MORE than
 * one top-level navigation (a client-side `location.replace` / meta-refresh
 * during the settle window is a fresh `requestId === loaderId`), so we track a
 * SET of main requestIds — not just the first — and collect the hops of each.
 * Walking these reconstructs every address Chrome dialed for the top document
 * over the whole capture window — the thing a pre-navigation `dns.lookup` can't
 * know, because Chrome resolves DNS itself (the rebinding TOCTOU).
 *
 * Pure + exported so the SSRF-pin decision is unit-testable without a live
 * browser. Returns `{ hops: [{ requestId, url, remoteIPAddress, status,
 * fromServiceWorker, fromDiskCache, fromPrefetchCache,
 * serviceWorkerResponseSource }], finalUrl, mainRequestIds: string[],
 * pendingMainRequestIds: string[], pendingMainRequestUrls: string[] }` (the
 * URLs are positional to the pending ids, so a refusal can name the destination
 * without re-parsing the stream). The delivery flags ride along so the gate
 * can tell "Chrome dialed somewhere we can't see" apart from "Chrome made no
 * connection at all" (see `hopMadeNoConnection`), and `requestId` keeps the hops
 * of ONE top-level navigation distinguishable from another's.
 * `pendingMainRequestIds` are top-level navigations that STARTED but produced no
 * `responseReceived` in the captured window — i.e. a navigation still in flight
 * whose final connection IP was never observed. The caller must fail closed on a
 * non-empty pending set: Chrome could complete that navigation (to a private /
 * metadata target) right after we stop capturing, leaving it unpinned. A
 * navigation Chrome reported as CANCELED (`Network.loadingFailed` with
 * `canceled`/`net::ERR_ABORTED` — what a client-side route change that
 * supersedes an in-flight one produces) is NOT pending: it was abandoned before
 * any answer, so nothing commits and no connection outcome is hidden. Any other
 * failure kind stays pending and keeps failing closed — see
 * `navigationWasCanceled`.
 */
export function pickMainFrameHops(messages, topFrameId = null) {
  // CDP sets `requestId === loaderId` on the main resource of EVERY frame — the
  // top document AND cross-origin sub-frames (iframes). When the caller passes
  // the top frame's `frameId` (from the `Page.navigate` response) we classify a
  // top-level navigation by `frameId === topFrameId` instead, so a slow/cached
  // iframe document can't land in the pending/empty-IP gate and over-refuse a safe
  // public page. Defensive fallback: if NO document request in the stream carries
  // `topFrameId` (a frameId-format surprise), retain the `requestId === loaderId`
  // classification so the gate can never regress to refuse-all. Sub-frame /
  // sub-resource IPs are still fully verified by `collectConnectedIps`.
  const useFrameId = topFrameId != null && messages.some((m) => (
    m?.method === 'Network.requestWillBeSent' && m.params?.type === 'Document' && m.params?.frameId === topFrameId
  ));
  const isMainDocRequest = (p) => p.type === 'Document' && p.requestId
    && (useFrameId ? p.frameId === topFrameId : p.requestId === p.loaderId);
  const mainRequestIds = new Set();
  const respondedIds = new Set();
  const failedIds = new Set();
  // Latest requested URL per main-frame navigation (a redirect overwrites it),
  // so a pending navigation can be NAMED in the refusal without a second parse.
  const mainRequestUrls = new Map();
  const hops = [];
  let finalUrl = null;
  for (const msg of messages) {
    const p = msg?.params;
    if (!p) continue;
    if (msg.method === 'Network.requestWillBeSent') {
      if (isMainDocRequest(p)) {
        mainRequestIds.add(p.requestId);
      }
      if (mainRequestIds.has(p.requestId)) {
        if (p.request?.url) mainRequestUrls.set(p.requestId, p.request.url);
        if (p.redirectResponse) hops.push(toHop(p.redirectResponse, p.requestId));
      }
    } else if (msg.method === 'Network.responseReceived') {
      if (mainRequestIds.has(p.requestId) && p.response) {
        respondedIds.add(p.requestId);
        hops.push(toHop(p.response, p.requestId));
        finalUrl = p.response.url || finalUrl;
      }
    } else if (msg.method === 'Network.loadingFailed' && mainRequestIds.has(p.requestId)) {
      // ONLY a navigation Chrome CANCELED clears the pending gate. A cancel is
      // "this load was abandoned before any answer" — nothing committed and no
      // connection outcome is being hidden. Every OTHER failure kind
      // (ERR_CONNECTION_RESET, ERR_CONNECTION_REFUSED, …) means Chrome did
      // reach out and got something back, and `loadingFailed` carries no
      // `remoteIPAddress`, so we cannot verify WHERE — a private endpoint that
      // accepts and resets would otherwise pass unpinned. Those stay pending
      // and the gate keeps failing closed on them.
      // A failure arriving AFTER the response is only a truncated body, and
      // that hop is already pinned, so `respondedIds` still wins either way.
      if (navigationWasCanceled(p)) failedIds.add(p.requestId);
    }
  }
  const pendingMainRequestIds = [...mainRequestIds]
    .filter((id) => !respondedIds.has(id) && !failedIds.has(id));
  return {
    hops,
    finalUrl,
    mainRequestIds: [...mainRequestIds],
    pendingMainRequestIds,
    pendingMainRequestUrls: pendingMainRequestIds.map((id) => mainRequestUrls.get(id) || '(url unknown)'),
  };
}

// Session-scoped CDP commands the pinned tab issues after `Network.enable` and
// BEFORE `Page.navigate`, so that the main document arrives with a peer address
// the SSRF pin can actually verify. Both remove a delivery path that hands
// Chrome a response it cannot annotate with a `remoteIPAddress`:
//   - `setBypassServiceWorker`: a SW-mediated document carries no peer address
//     even when the worker passed the fetch straight through to the network,
//     which made every PWA unreadable behind the fail-closed empty-IP gate.
//   - `setCacheDisabled`: a document served from the HTTP/prefetch cache made no
//     connection at all, so nothing about the *current* resolution of its host
//     was verified — a body cached earlier from a since-blocked address would be
//     ingested unpinned. Forcing a real fetch is what the pin is for.
// Both are scoped to this fresh, disposable tab, so the user's normal browsing
// is unaffected; cookies are untouched, so a signed-in session still applies.
// Ids are offset well past the navigate (2) / read (3) request ids.
const PIN_SETUP_COMMANDS = [
  { method: 'Network.setBypassServiceWorker', params: { bypass: true } },
  { method: 'Network.setCacheDisabled', params: { cacheDisabled: true } },
];
const PIN_SETUP_ID_BASE = 10;

// Close a CDP tab by target id (best-effort). Used by `navigateToUrlPinned` to
// fail closed after an SSRF-pin refusal (a tab that connected to a disallowed
// address is torn down rather than left open for the DOM reader) AND to tear
// down a tab it read from itself (`closeAfterRead`). Read callers should NOT
// call this for a tab whose read `navigateToUrlPinned` performed — that tab is
// already closed. It stays exported for callers that own a tab outright: a
// handoff, or `POST /api/browser/navigate`, whose tab IS the deliverable.
export async function closeCdpPage(id) {
  if (!id) return;
  await cdpRequest(`/json/close/${id}`, { timeout: HEALTH_TIMEOUT_MS }).catch(() => {});
}

// Every address Chrome ACTUALLY dialed across the capture window — the main
// document, its redirects, AND every sub-resource / XHR / fetch the page issued
// (any request type), each with a non-empty `remoteIPAddress`. Empty IPs
// (data:/blob:/cache/service-worker responses — no network connection) are
// omitted so legit pages aren't false-refused. Pure; exported for testing.
export function collectConnectedIps(messages) {
  const out = [];
  for (const msg of messages) {
    const p = msg?.params;
    if (!p) continue;
    if (msg.method === 'Network.requestWillBeSent' && p.redirectResponse?.remoteIPAddress) {
      out.push({ url: p.redirectResponse.url || null, remoteIPAddress: p.redirectResponse.remoteIPAddress });
    } else if (msg.method === 'Network.responseReceived' && p.response?.remoteIPAddress) {
      out.push({ url: p.response.url || null, remoteIPAddress: p.response.remoteIPAddress });
    }
  }
  return out;
}

// Hosts of every WebSocket the page opened during the capture window. CDP routes
// WS through dedicated `Network.webSocket*` events whose payloads carry NO
// `remoteIPAddress`, so we can only gate the WS by its URL host, not by Chrome's
// actual connect IP (the resolver-level pin HTTP gets). Pure; exported for tests.
export function collectWebSocketHosts(messages) {
  const out = [];
  for (const msg of messages) {
    if (msg?.method !== 'Network.webSocketCreated') continue;
    const raw = msg.params?.url;
    if (typeof raw !== 'string') continue;
    out.push({ url: raw, host: hostOf(raw) });
  }
  return out;
}

// Pure gate over a captured CDP message stream: returns a refusal reason string,
// or null when the navigation is safe to read. Exported for unit testing.
export function ssrfPinRefusalReason(messages, verifyRemoteIp, url, topFrameId = null) {
  const { hops, pendingMainRequestUrls } = pickMainFrameHops(messages, topFrameId);
  if (!hops.length) return 'no main-frame document response was observed';
  // The main document must have a verifiable (present) connection IP — an empty
  // one can't be checked, so fail closed. The ONE exception is a hop Chrome
  // explicitly flagged as served without a connection (disk/prefetch cache, or a
  // service worker answering from its own store): there is no peer to pin, and
  // refusing it false-positives every PWA. Two conditions bound that exception so
  // it can never stand in for a network check:
  //   1. Another hop of the SAME top-level navigation (same requestId — i.e. an
  //      earlier link in this redirect chain) must have verified a real IP. A
  //      verified IP from a DIFFERENT navigation proves nothing about this one:
  //      a page that loads clean from public and then client-side-navigates to a
  //      cached `http://127.0.0.1/…` document would otherwise be admitted.
  //   2. The hop's own URL host must still pass `verifyRemoteIp` — that catches a
  //      cached document whose URL is a blocked literal (loopback/metadata),
  //      which is the only address signal a connectionless hop carries. (Same
  //      host-level fallback the WebSocket gate uses.)
  const verifiedRequestIds = new Set(hops.filter((h) => h.remoteIPAddress).map((h) => h.requestId));
  for (const hop of hops) {
    if (hop.remoteIPAddress) continue;
    const noConnection = hopMadeNoConnection(hop);
    const host = hostOf(hop.url);
    if (noConnection && verifiedRequestIds.has(hop.requestId) && host && verifyRemoteIp(host)) continue;
    const detail = noConnection
      ? `${describeHopDelivery(hop)}; no verified network address for this navigation`
      : describeHopDelivery(hop);
    return `Chrome connected to an unverifiable address for ${hop.url || url} (${detail})`;
  }
  // A top-level navigation that STARTED, produced no response, and was not
  // reported as failed was never pinned — Chrome could be mid-connect to a
  // private/metadata target. Name the URL(s): the bare message is undiagnosable
  // once the capture window is gone.
  if (pendingMainRequestUrls.length) {
    return `a top-level navigation was still in flight (unpinned): ${pendingMainRequestUrls.join(', ')}`;
  }
  // EVERY connection Chrome made must dial an allowed address — not just the
  // main document. A rebinding page can load public, then `fetch()` its
  // now-private-resolving hostname; the browser treats it as same-origin, JS
  // injects that private response into the DOM we ingest, and the sub-resource's
  // real `remoteIPAddress` surfaces it here. (`isBlockedIngestHost` blocks only
  // loopback/link-local/metadata, not RFC1918 LAN, so LAN pages aren't refused.)
  for (const conn of collectConnectedIps(messages)) {
    if (!verifyRemoteIp(conn.remoteIPAddress)) {
      return `Chrome connected to a disallowed address ${conn.remoteIPAddress} for ${conn.url || url}`;
    }
  }
  // WebSockets: CDP exposes no remoteIPAddress for WS, so we can only refuse a WS
  // opened to a blocked HOST (a direct ws://127.0.0.1 / ws://localhost / metadata
  // literal). A WS to a hostname that DNS-rebinds to a private IP is a residual
  // this interception approach can't see — closing it fully needs Chrome-launch
  // `--host-resolver-rules` (a per-navigation relaunch of the shared browser,
  // out of scope here). Bounded by the single-user trust model; cloud metadata,
  // the primary target, is HTTP-only and fully covered above.
  for (const ws of collectWebSocketHosts(messages)) {
    if (!ws.host || !verifyRemoteIp(ws.host)) {
      return `page opened a WebSocket to a disallowed host ${ws.host || '(unparseable)'} (${ws.url})`;
    }
  }
  return null;
}

/**
 * Navigate to a URL in a fresh tab and verify — against Chrome's OWN reported
 * connection IP — that EVERY main-frame hop connected to an allowed address:
 * the initial `Page.navigate`, every HTTP redirect, AND any client-side
 * top-level navigation (meta-refresh / `location.replace`) that fires during the
 * post-load `settleMs` window. This closes the DNS-rebinding TOCTOU a
 * pre-navigation `dns.lookup` cannot — Chrome resolves DNS itself, so we open a
 * BLANK tab, subscribe to CDP Network events, THEN drive `Page.navigate`, keep
 * the subscription open across the settle window, and check the
 * `remoteIPAddress` Chrome actually dialed for each hop. The tab also bypasses
 * the site's service worker and disables its cache (`PIN_SETUP_COMMANDS`), so
 * the main document is fetched by Chrome itself and therefore carries a
 * pinnable peer IP instead of arriving from a store we can't verify.
 *
 * `verifyRemoteIp(ip)` returns false to refuse. On ANY refusal (unverifiable /
 * empty IP, a navigation that never yields a document response, or a top-level
 * nav still in flight) we fail closed: close the tab and throw, so a
 * rebind-to-private answer never reaches the caller.
 *
 * When `evaluateExpression` is given, the DOM read runs on the SAME CDP session
 * (a `Runtime.evaluate` after settle), and the pin is RE-checked over events
 * captured up to and during that read — so there is no gap between "stop
 * monitoring" and "read the DOM" for a late client-side navigation to slip
 * through. The evaluated value is returned as `evalResult` (or null). Without
 * `evaluateExpression` the caller gets a page handle to read separately.
 *
 * TAB OWNERSHIP follows the read, and is NOT the caller's to remember:
 * `closeAfterRead` defaults to true exactly when `evaluateExpression` was
 * supplied, because a tab we already read from is scratch — leaving it open
 * litters the user's browser one tab per navigation (which is precisely how the
 * catalog URL ingest and the Stacker News identity check each leaked). So the
 * teardown happens HERE, on both the refusal path and the success path. Only a
 * caller that omits `evaluateExpression` — one for whom the TAB is the
 * deliverable (a browser handoff, `POST /api/browser/navigate`) — gets a tab
 * back to close on its own schedule. Pass `closeAfterRead: false` to read AND
 * keep the tab; passing it explicitly decides teardown either way.
 *
 * Because of that, `id` / `webSocketDebuggerUrl` in the return value name a
 * CLOSED tab whenever this function performed the read. They are still returned
 * (for logging and for the `closeAfterRead: false` case) but must NOT be used to
 * re-derive a handoff URL, re-evaluate on the session, or close the tab again.
 *
 * The caller does NOT sleep — the settle wait happens HERE, so the DOM has had
 * `settleMs` to render (and every navigation in that window is pinned) by the
 * time this resolves. Returns `{ id, url, title, webSocketDebuggerUrl, evalResult }`.
 */
export async function navigateToUrlPinned(url, {
  verifyRemoteIp,
  settleMs = 0,
  navigateTimeoutMs = NAVIGATE_TIMEOUT_MS,
  evaluateExpression = null,
  evaluateTimeoutMs = CDP_EVALUATE_TIMEOUT_MS,
  closeAfterRead = Boolean(evaluateExpression),
} = {}) {
  if (typeof verifyRemoteIp !== 'function') {
    throw new Error('navigateToUrlPinned requires a verifyRemoteIp(ip) predicate');
  }

  // Open a BLANK tab first so Network listeners attach BEFORE the target URL is
  // fetched — `/json/new?<url>` would navigate immediately and we'd miss the
  // document request (and its remoteIPAddress).
  const response = await cdpRequest('/json/new?about:blank', { method: 'PUT', timeout: navigateTimeoutMs });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`CDP open-blank failed (${response.status}): ${text}`);
  }
  const target = await readResponseJson(response, { fallback: null, emptyValue: null });
  if (!target?.id || !target?.webSocketDebuggerUrl) {
    throw new Error(`CDP open-blank returned a malformed response for ${url}`);
  }

  const READ_ID = 3;
  const { default: WebSocket } = await import('ws');
  const messages = [];
  const result = await new Promise((resolve) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let settled = false;
    let phase = 'nav';
    // The top frame's id, reported by the `Page.navigate` response (id 2). Threaded
    // into the pin so ONLY the top document gates the pending/empty-IP checks —
    // slow/cached iframes (which also carry `requestId === loaderId`) don't.
    let topFrameId = null;
    let overallTimer;
    let settleTimer = null;
    let evalTimer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      clearTimeout(settleTimer);
      clearTimeout(evalTimer);
      try { ws.close(); } catch {}
      resolve(value);
    };
    // Overall cap: fail closed if the FIRST document response never arrives.
    overallTimer = setTimeout(
      () => finish({ ok: false, reason: 'navigation timed out before the document response' }),
      navigateTimeoutMs,
    );

    // Settle expired: verify everything captured so far, then either read the DOM
    // on THIS same session (so no monitoring gap) or resolve for a separate read.
    const onSettleEnd = () => {
      const bad = ssrfPinRefusalReason(messages, verifyRemoteIp, url, topFrameId);
      if (bad) return finish({ ok: false, reason: bad });
      if (!evaluateExpression) {
        const { finalUrl } = pickMainFrameHops(messages, topFrameId);
        return finish({ ok: true, finalUrl, evalResult: null });
      }
      phase = 'read';
      evalTimer = setTimeout(() => finish({ ok: false, reason: 'DOM read timed out' }), evaluateTimeoutMs);
      ws.send(JSON.stringify({
        id: READ_ID,
        method: 'Runtime.evaluate',
        params: { expression: evaluateExpression, returnByValue: true, awaitPromise: true },
      }));
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
      PIN_SETUP_COMMANDS.forEach((cmd, i) => ws.send(JSON.stringify({ id: PIN_SETUP_ID_BASE + i, ...cmd })));
      ws.send(JSON.stringify({ id: 2, method: 'Page.navigate', params: { url } }));
    });
    ws.on('message', (data) => {
      const msg = safeJSONParse(data.toString(), null, { context: 'cdp-pin' });
      if (!msg) return;
      // A Page.navigate Chrome rejects outright (bad scheme, etc.) errors on id 2;
      // otherwise its result carries the top frame's `frameId` we pin against.
      if (msg.id === 2) {
        if (msg.error) return finish({ ok: false, reason: msg.error.message || 'navigate rejected' });
        if (msg.result?.frameId) topFrameId = msg.result.frameId;
        return;
      }
      const setupIndex = msg.id - PIN_SETUP_ID_BASE;
      if (setupIndex >= 0 && setupIndex < PIN_SETUP_COMMANDS.length) {
        // Non-fatal: a Chrome that rejects one of these just keeps its service
        // worker / cache in front of the document, and the empty-IP gate still
        // fails closed on the unpinnable response — never under-verifies.
        if (msg.error) console.warn(`⚠️ CDP ${PIN_SETUP_COMMANDS[setupIndex].method} rejected: ${msg.error.message || 'unknown error'}`);
        return;
      }
      if (msg.id === READ_ID) {
        // DOM read returned. RE-verify over ALL events captured up to now: any
        // top-level navigation that committed during the read is in `messages`,
        // so a late rebind that changed the page under us fails closed here.
        const bad = ssrfPinRefusalReason(messages, verifyRemoteIp, url, topFrameId);
        if (bad) return finish({ ok: false, reason: bad });
        const evalResult = (msg.error || msg.result?.exceptionDetails) ? null : (msg.result?.result?.value ?? null);
        const { finalUrl } = pickMainFrameHops(messages, topFrameId);
        return finish({ ok: true, finalUrl, evalResult });
      }
      if (!msg.method) return;
      messages.push(msg);
      // First main-frame document RESPONSE (type 'Document', emitted before any
      // sub-frame doc) starts the settle window; keep capturing across it so a
      // client-side navigation during settle is pinned too.
      if (phase === 'nav' && msg.method === 'Network.responseReceived' && msg.params?.type === 'Document' && !settleTimer) {
        clearTimeout(overallTimer);
        settleTimer = setTimeout(onSettleEnd, settleMs);
      }
    });
    ws.on('error', () => finish({ ok: false, reason: 'CDP websocket error during navigation' }));
  });

  if (!result.ok) {
    await closeCdpPage(target.id);
    throw new Error(`refusing to ingest: ${result.reason}`);
  }

  // The read (if any) already happened on this session, so the tab has served
  // its purpose — tear it down here rather than trusting every call site to.
  if (closeAfterRead) await closeCdpPage(target.id);

  return {
    id: target.id,
    url: result.finalUrl || url,
    title: '',
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
    evalResult: result.evalResult,
  };
}

// ---------- CDP page listing (UI-shaped subset) ----------

export async function getOpenPages() {
  const pages = await listCdpPages();
  return pages.map(p => ({
    id: p.id,
    title: p.title || '(untitled)',
    url: p.url,
    type: p.type
  }));
}

// ---------- CDP version info ----------

export async function getCdpVersion() {
  const response = await cdpRequest('/json/version', { timeout: HEALTH_TIMEOUT_MS }).catch(() => null);
  if (!response || !response.ok) return null;
  // Preserve the null-on-failure contract: the /version route 503s when this is
  // falsy, so a malformed body must stay null, not become a truthy {}.
  return readResponseJson(response, { fallback: null, emptyValue: null });
}

// ---------- Downloads ----------

export async function getDownloads() {
  const config = await loadConfig();
  const downloadDir = config.downloadDir || DEFAULT_DOWNLOAD_DIR;
  const entries = await readdir(downloadDir).catch(() => []);
  // Filter out hidden files and .crdownload (partial Chrome downloads)
  const files = [];
  for (const name of entries) {
    if (name.startsWith('.') || name.endsWith('.crdownload')) continue;
    const filePath = join(downloadDir, name);
    const info = await stat(filePath).catch(() => null);
    if (info?.isFile()) {
      files.push({
        name,
        size: info.size,
        modified: info.mtime.toISOString()
      });
    }
  }
  // Most recent first
  files.sort((a, b) => b.modified.localeCompare(a.modified));
  return { downloadDir, files };
}

const DOWNLOAD_MIME_TYPES = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.csv': 'text/csv', '.xml': 'application/xml', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed'
};

export async function resolveDownload(name) {
  const config = await loadConfig();
  const downloadDir = resolve(config.downloadDir || DEFAULT_DOWNLOAD_DIR);
  const safeName = basename(name || '');
  if (!safeName || safeName.startsWith('.') || safeName.endsWith('.crdownload')) return null;
  const absPath = resolve(downloadDir, safeName);
  if (!absPath.startsWith(downloadDir + '/')) return null;
  const info = await stat(absPath).catch(() => null);
  if (!info?.isFile()) return null;
  const ext = extname(safeName).toLowerCase();
  return {
    absPath,
    name: safeName,
    ext,
    mime: DOWNLOAD_MIME_TYPES[ext] || 'application/octet-stream'
  };
}

export async function deleteDownload(name) {
  const file = await resolveDownload(name);
  if (!file) return false;
  await unlink(file.absPath);
  return true;
}

// ---------- Full combined status ----------

export async function getFullStatus() {
  const [health, process, pages, version, config, downloads] = await Promise.all([
    getHealthStatus(),
    getProcessStatus(),
    getOpenPages().catch(() => []),
    getCdpVersion().catch(() => null),
    getConfig(),
    getDownloads().catch(() => ({ downloadDir: DEFAULT_DOWNLOAD_DIR, files: [] }))
  ]);

  return {
    ...health,
    process,
    pages,
    pageCount: pages.length,
    version,
    config,
    downloads
  };
}
