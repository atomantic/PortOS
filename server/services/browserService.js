/**
 * Browser Service - manages the portos-browser CDP instance
 * Communicates with the portos-browser process (port 5557 health, port 5556 CDP)
 * Stores config in data/browser-config.json
 */

import { readdir, stat, unlink } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, basename, resolve, extname } from 'path';
import { EventEmitter } from 'events';
import { ensureDir, safeJSONParse, PATHS, tryReadFile, atomicWrite } from '../lib/fileUtils.js';
import { normalizeBrowserConfig } from '../lib/browserConfig.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { readResponseJson } from '../lib/readResponseJson.js';

const execFileAsync = promisify(execFile);
const PM2_SHELL = process.platform === 'win32';
const PM2_SETTLE_MS = 1500;
const HEALTH_TIMEOUT_MS = 3000;
const NAVIGATE_TIMEOUT_MS = 10000;
const LOGS_TIMEOUT_MS = 5000;
const CDP_DEFAULT_TIMEOUT_MS = 10000;
const CDP_EVALUATE_TIMEOUT_MS = 60000;

// Auth/login redirect detection across providers (Microsoft, Okta, generic)
const AUTH_PATTERNS = ['login.microsoftonline.com', 'okta.com', 'login.live.com', 'Sign in'];

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
  await execFileAsync('pm2', [action, ...args], { shell: PM2_SHELL });
  console.log(`✅ Browser PM2 ${action} complete`);

  // Give PM2 a moment to settle
  await new Promise(resolve => setTimeout(resolve, PM2_SETTLE_MS));

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
  const { stdout } = await execFileAsync('pm2', ['jlist'], { shell: PM2_SHELL });
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
  const { stdout, stderr } = await execFileAsync('pm2', ['logs', 'portos-browser', '--nostream', '--lines', String(lines)], {
    timeout: LOGS_TIMEOUT_MS,
    shell: PM2_SHELL
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
 * browser. Returns `{ hops: [{ url, remoteIPAddress, status }], finalUrl,
 * mainRequestIds: string[], pendingMainRequestIds: string[] }`.
 * `pendingMainRequestIds` are top-level navigations that STARTED but produced no
 * `responseReceived` in the captured window — i.e. a navigation still in flight
 * whose final connection IP was never observed. The caller must fail closed on a
 * non-empty pending set: Chrome could complete that navigation (to a private /
 * metadata target) right after we stop capturing, leaving it unpinned.
 */
export function pickMainFrameHops(messages) {
  const mainRequestIds = new Set();
  const respondedIds = new Set();
  const hops = [];
  let finalUrl = null;
  for (const msg of messages) {
    const p = msg?.params;
    if (!p) continue;
    if (msg.method === 'Network.requestWillBeSent') {
      // A Document request whose requestId equals its loaderId is a top-level
      // navigation; ignore sub-resource / sub-frame requests.
      if (p.type === 'Document' && p.requestId && p.requestId === p.loaderId) {
        mainRequestIds.add(p.requestId);
      }
      if (mainRequestIds.has(p.requestId) && p.redirectResponse) {
        hops.push({
          url: p.redirectResponse.url || null,
          remoteIPAddress: p.redirectResponse.remoteIPAddress || '',
          status: p.redirectResponse.status ?? null,
        });
      }
    } else if (msg.method === 'Network.responseReceived') {
      if (mainRequestIds.has(p.requestId) && p.response) {
        respondedIds.add(p.requestId);
        hops.push({
          url: p.response.url || null,
          remoteIPAddress: p.response.remoteIPAddress || '',
          status: p.response.status ?? null,
        });
        finalUrl = p.response.url || finalUrl;
      }
    }
  }
  const pendingMainRequestIds = [...mainRequestIds].filter((id) => !respondedIds.has(id));
  return { hops, finalUrl, mainRequestIds: [...mainRequestIds], pendingMainRequestIds };
}

// Close a CDP tab by target id (best-effort). Used to fail closed after an
// SSRF-pin refusal so a tab that connected to a disallowed address is torn down
// rather than left open for the DOM reader.
async function closeCdpPage(id) {
  if (!id) return;
  await cdpRequest(`/json/close/${id}`, { timeout: HEALTH_TIMEOUT_MS }).catch(() => {});
}

// Pure gate over a captured CDP message stream: returns a refusal reason string,
// or null when every main-frame hop connected to an allowed address and no
// top-level navigation is still in flight. Exported for unit testing.
export function ssrfPinRefusalReason(messages, verifyRemoteIp, url) {
  const { hops, pendingMainRequestIds } = pickMainFrameHops(messages);
  if (!hops.length) return 'no main-frame document response was observed';
  for (const hop of hops) {
    if (!hop.remoteIPAddress || !verifyRemoteIp(hop.remoteIPAddress)) {
      return `Chrome connected to a disallowed address ${hop.remoteIPAddress || '(unknown)'} for ${hop.url || url}`;
    }
  }
  // A top-level navigation that STARTED but produced no response was never
  // pinned — Chrome could be mid-connect to a private/metadata target.
  if (pendingMainRequestIds.length) return 'a top-level navigation was still in flight (unpinned)';
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
 * `remoteIPAddress` Chrome actually dialed for each hop.
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
      const bad = ssrfPinRefusalReason(messages, verifyRemoteIp, url);
      if (bad) return finish({ ok: false, reason: bad });
      if (!evaluateExpression) {
        const { finalUrl } = pickMainFrameHops(messages);
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
      ws.send(JSON.stringify({ id: 2, method: 'Page.navigate', params: { url } }));
    });
    ws.on('message', (data) => {
      const msg = safeJSONParse(data.toString(), null, { context: 'cdp-pin' });
      if (!msg) return;
      // A Page.navigate Chrome rejects outright (bad scheme, etc.) errors on id 2.
      if (msg.id === 2 && msg.error) return finish({ ok: false, reason: msg.error.message || 'navigate rejected' });
      if (msg.id === READ_ID) {
        // DOM read returned. RE-verify over ALL events captured up to now: any
        // top-level navigation that committed during the read is in `messages`,
        // so a late rebind that changed the page under us fails closed here.
        const bad = ssrfPinRefusalReason(messages, verifyRemoteIp, url);
        if (bad) return finish({ ok: false, reason: bad });
        const evalResult = (msg.error || msg.result?.exceptionDetails) ? null : (msg.result?.result?.value ?? null);
        const { finalUrl } = pickMainFrameHops(messages);
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
