/**
 * Browser Service - manages the portos-browser CDP instance
 * Communicates with the portos-browser process (port 5557 health, port 5556 CDP)
 * Stores config in data/browser-config.json
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { safeJSONParse } from '../lib/fileUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(PROJECT_ROOT, 'data');
const CONFIG_FILE = join(DATA_DIR, 'browser-config.json');
const ECOSYSTEM_FILE = join(PROJECT_ROOT, 'ecosystem.config.cjs');

export const browserEvents = new EventEmitter();

const DEFAULT_PROFILE_DIR = join(DATA_DIR, 'browser-profile');

const DEFAULT_CONFIG = {
  cdpPort: 5556,
  cdpHost: '127.0.0.1',
  healthPort: 5557,
  autoConnect: true,
  headless: true,
  userDataDir: DEFAULT_PROFILE_DIR
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
  await mkdir(DATA_DIR, { recursive: true });
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
  const healthUrl = `http://127.0.0.1:${config.healthPort}/health`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  const response = await fetch(healthUrl, { signal: controller.signal }).catch(() => null);
  clearTimeout(timeout);

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
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  console.log(`🌐 Browser PM2 ${action}: portos-browser`);
  await execFileAsync('pm2', [action, ...args], { shell: process.platform === 'win32' });
  console.log(`✅ Browser PM2 ${action} complete`);

  // Give PM2 a moment to settle
  await new Promise(resolve => setTimeout(resolve, 1500));

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
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const { stdout } = await execFileAsync('pm2', ['jlist'], { shell: process.platform === 'win32' });
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
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const { stdout, stderr } = await execFileAsync('pm2', ['logs', 'portos-browser', '--nostream', '--lines', String(lines)], {
    timeout: 5000,
    shell: process.platform === 'win32'
  }).catch(() => ({ stdout: '', stderr: '' }));

  return { stdout: stdout || '', stderr: stderr || '' };
}

// ---------- CDP navigation ----------

export async function navigateToUrl(url) {
  const config = await loadConfig();
  const newTabUrl = `http://${config.cdpHost}:${config.cdpPort}/json/new?${encodeURIComponent(url)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  const response = await fetch(newTabUrl, { method: 'PUT', signal: controller.signal });
  clearTimeout(timeout);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`CDP navigate failed (${response.status}): ${text}`);
  }

  const page = await response.json();
  console.log(`🌐 Opened ${url} in CDP browser (tab ${page.id})`);
  return { id: page.id, title: page.title || '(loading)', url: page.url, type: page.type };
}

// ---------- CDP page listing (connects to the debug endpoint) ----------

export async function getOpenPages() {
  const config = await loadConfig();
  const listUrl = `http://${config.cdpHost}:${config.cdpPort}/json/list`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  const response = await fetch(listUrl, { signal: controller.signal }).catch(() => null);
  clearTimeout(timeout);

  if (!response || !response.ok) {
    return [];
  }

  const pages = await response.json();
  return pages.map(p => ({
    id: p.id,
    title: p.title || '(untitled)',
    url: p.url,
    type: p.type
  }));
}

// ---------- CDP version info ----------

export async function getCdpVersion() {
  const config = await loadConfig();
  const versionUrl = `http://${config.cdpHost}:${config.cdpPort}/json/version`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  const response = await fetch(versionUrl, { signal: controller.signal }).catch(() => null);
  clearTimeout(timeout);

  if (!response || !response.ok) return null;
  return response.json();
}

// ---------- Full combined status ----------

export async function getFullStatus() {
  const [health, process, pages, version, config] = await Promise.all([
    getHealthStatus(),
    getProcessStatus(),
    getOpenPages().catch(() => []),
    getCdpVersion().catch(() => null),
    getConfig()
  ]);

  return {
    ...health,
    process,
    pages,
    pageCount: pages.length,
    version,
    config
  };
}
