/**
 * Browser Service - manages the portos-browser CDP instance
 * Communicates with the portos-browser process (port 5557 health, port 5556 CDP)
 * Stores config in data/browser-config.json
 */

import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { EventEmitter } from 'events';
import { ensureDir, safeJSONParse, PATHS } from '../lib/fileUtils.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';

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
  headless: true,
  userDataDir: DEFAULT_PROFILE_DIR,
  downloadDir: DEFAULT_DOWNLOAD_DIR
};

let cachedConfig = null;

// ---------- Config persistence ----------

export async function loadConfig() {
  if (cachedConfig) return cachedConfig;
  const raw = await readFile(CONFIG_FILE, 'utf-8').catch(() => null);
  const parsed = safeJSONParse(raw, null);
  cachedConfig = parsed ? { ...DEFAULT_CONFIG, ...parsed } : { ...DEFAULT_CONFIG };
  return cachedConfig;
}

export async function saveConfig(config) {
  await ensureDir(PATHS.data);
  cachedConfig = { ...DEFAULT_CONFIG, ...config };
  await writeFile(CONFIG_FILE, JSON.stringify(cachedConfig, null, 2));
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

  const data = await response.json();
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
  return response.json();
}

export async function findOrOpenPage(targetUrl) {
  const pages = await listCdpPages();
  const existing = pages.find(p => p.url?.includes(new URL(targetUrl).hostname));
  if (existing) return existing;
  const response = await cdpRequest(`/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' });
  if (!response.ok) return null;
  return response.json();
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

  const page = await response.json();
  console.log(`🌐 Opened ${url} in CDP browser (tab ${page.id})`);
  return { id: page.id, title: page.title || '(loading)', url: page.url, type: page.type };
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
  return response.json();
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
