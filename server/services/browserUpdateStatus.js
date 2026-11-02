import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from '../lib/childProcess.js';
import { browserExecutablePath, deriveMacAppBundleFromChromePath } from '../lib/browserConfig.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { safeChildProcessOptions, withoutServerSecretsEnv } from '../lib/processEnv.js';
import { getConfig, getHealthStatus } from './browserService.js';
import { listExistingProcessesStrict } from './pm2.js';

const runFile = promisify(execFile);
const CHROME_CHANNELS = Object.freeze({
  'com.google.Chrome': 'stable',
  'com.google.Chrome.beta': 'beta',
  'com.google.Chrome.dev': 'dev',
  'com.google.Chrome.canary': 'canary',
});
const VERSION = /^\d+\.\d+\.\d+\.\d+$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);
const COMMAND_TIMEOUT_MS = 5000;
const RELEASE_TIMEOUT_MS = 10000;
const RELEASE_TTL_MS = 6 * 60 * 60 * 1000;
const RELEASE_RETRY_MS = 15 * 60 * 1000;
const CONFIG_KEYS = ['cdpHost', 'cdpPort', 'healthPort', 'headless', 'chromePath', 'macAppBundle', 'userDataDir', 'downloadDir', 'autoConnect'];
const releaseCache = new Map();

export function compareChromeVersions(a, b) {
  if (!VERSION.test(a || '') || !VERSION.test(b || '')) return null;
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  if (![...left, ...right].every(Number.isSafeInteger)) return null;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

function listenerPid(output) {
  const pids = [...new Set(output.split(/\r?\n/).filter(line => /^p\d+$/.test(line)).map(line => line.slice(1)))];
  return pids.length === 1 ? pids[0] : null;
}

async function latestPublished(channel, platform) {
  const key = `${platform}:${channel}`;
  const cached = releaseCache.get(key);
  if (cached && Date.now() - cached.at < (cached.version ? RELEASE_TTL_MS : RELEASE_RETRY_MS)) return cached.version;
  const url = `https://versionhistory.googleapis.com/v1/chrome/platforms/${platform}/channels/${channel}/versions?order_by=version%20desc&pageSize=1`;
  const version = await fetchWithTimeout(url, {}, RELEASE_TIMEOUT_MS).then(async response => {
    if (!response.ok) { await response.body?.cancel(); return null; }
    const body = await response.json();
    const value = body?.versions?.[0]?.version;
    return typeof value === 'string' && VERSION.test(value) ? value : null;
  }).catch(() => null);
  releaseCache.set(key, { version, at: Date.now() });
  return version;
}

async function readVersionAtCdp({ cdpHost, cdpPort }) {
  const host = cdpHost === '::1' ? '[::1]' : ['0.0.0.0', '::'].includes(cdpHost) ? '127.0.0.1' : cdpHost;
  const response = await fetchWithTimeout(`http://${host}:${cdpPort}/json/version`, {}, 3000);
  if (!response.ok) { await response.body?.cancel(); return null; }
  return response.json();
}

const validPort = port => Number.isInteger(port) && port > 0 && port < 65536;

export async function readManagedBrowserProcess() {
  const processes = await listExistingProcessesStrict();
  if (!processes) return { exists: null, status: 'unavailable' };
  const process = processes.find(entry => entry.name === 'portos-browser');
  return process ? { exists: true, status: process.status, pid: process.pid } : { exists: false, status: 'not_found' };
}

/** Read-only comparison of the running local CDP listener with its installed app. */
function createBrowserUpdateReader({
  platform = process.platform, readConfig = getConfig, readVersion = readVersionAtCdp, readHealth = getHealthStatus,
  readProcess = readManagedBrowserProcess, execute = runFile, canonical = realpath, fileStat = stat, readRelease = latestPublished,
} = {}) {
  const command = (file, args) => execute(file, args, safeChildProcessOptions({ timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024, env: withoutServerSecretsEnv() }));
  const findListener = async port => listenerPid((await command('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'])).stdout);
  const fileStamp = async paths => Promise.all(paths.map(async path => {
    const info = await fileStat(path);
    return [info.dev, info.ino, info.size, info.mtimeMs];
  }));
  return async ({ includePublished = true, includeProof = false } = {}) => {
    if (platform !== 'darwin') return { state: 'unsupported', reason: 'platform' };
    try {
      const [config, process] = await Promise.all([readConfig({ strict: true }), readProcess()]);
      if (process?.exists === false || process?.status === 'stopped') return { state: 'stopped' };
      if (process?.status !== 'online' || !Number.isInteger(process.pid) || !LOCAL_HOSTS.has(config?.cdpHost)
        || !validPort(config.healthPort)) return { state: 'unverified' };
      if (await findListener(config.healthPort) !== String(process.pid)) return { state: 'unverified' };
      const health = await readHealth({ strict: true });
      if (!health?.connected || typeof health.headless !== 'boolean' || !LOCAL_HOSTS.has(health.cdpHost)
        || !validPort(health.cdpPort)) return { state: 'unverified' };
      const version = await readVersion(health);
      const runningVersion = /^Chrome\/(\d+\.\d+\.\d+\.\d+)$/.exec(version.Browser || '')?.[1];
      if (!runningVersion) return { state: 'unverified' };

      const pid = await findListener(health.cdpPort);
      if (!pid) return { state: 'unverified' };
      if (health.headless && (await command('/bin/ps', ['-p', pid, '-o', 'ppid='])).stdout.trim() !== String(process.pid)) return { state: 'unverified' };
      const processPath = await canonical((await command('/bin/ps', ['-p', pid, '-o', 'comm='])).stdout.trim());
      const bundle = deriveMacAppBundleFromChromePath(processPath);
      if (!bundle) return { state: 'unsupported', reason: 'browser' };
      const plistPath = join(bundle, 'Contents', 'Info.plist');
      const readPlist = async () => JSON.parse((await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath])).stdout);
      const plist = await readPlist();
      const channel = CHROME_CHANNELS[plist.CFBundleIdentifier];
      const installedVersion = plist.CFBundleShortVersionString;
      if (!channel) return { state: 'unsupported', reason: 'browser' };
      if (compareChromeVersions(runningVersion, installedVersion) === null || typeof plist.CFBundleExecutable !== 'string') return { state: 'unverified' };
      const expectedExecutable = join(bundle, 'Contents', 'MacOS', plist.CFBundleExecutable);
      if (processPath !== await canonical(expectedExecutable)) return { state: 'unverified' };
      const stampPaths = [bundle, plistPath, expectedExecutable];
      const beforeStamp = await fileStamp(stampPaths);

      const configuredExecutable = browserExecutablePath(config, 'darwin');
      const configuredBundle = config.macAppBundle || deriveMacAppBundleFromChromePath(configuredExecutable) || '/Applications/Google Chrome.app';
      const matchesConfig = config.headless === true
        ? processPath === await canonical(configuredExecutable)
        : await canonical(bundle) === await canonical(configuredBundle);
      if (!matchesConfig) return { state: 'configuration-mismatch', runningVersion, installedVersion, channel };

      const publishedVersions = includePublished ? Object.fromEntries(await Promise.all(['mac_arm64', 'mac'].map(async target => [target,
        await Promise.resolve().then(() => readRelease(channel, target)).catch(() => null)]))) : null;
      const [again, finalPid, finalSupervisor, finalHealth, finalConfig, finalProcess, finalPlist, afterStamp, finalExecutable] = await Promise.all([
        readVersion(health), findListener(health.cdpPort), findListener(config.healthPort), readHealth({ strict: true }),
        readConfig({ strict: true }), readProcess(), readPlist(), fileStamp(stampPaths),
        command('/bin/ps', ['-p', pid, '-o', 'comm=']).then(result => canonical(result.stdout.trim())),
      ]);
      if (again?.Browser !== version.Browser || finalPid !== pid || finalSupervisor !== String(process.pid)
        || finalProcess?.pid !== process.pid || finalProcess?.status !== 'online' || !finalHealth?.connected
        || finalHealth.cdpHost !== health.cdpHost || finalHealth.cdpPort !== health.cdpPort || finalHealth.headless !== health.headless
        || finalExecutable !== processPath || JSON.stringify(beforeStamp) !== JSON.stringify(afterStamp)
        || ['CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleExecutable'].some(key => finalPlist[key] !== plist[key])
        || CONFIG_KEYS.some(key => finalConfig[key] !== config[key])) return { state: 'unverified' };
      if (health.headless && (await command('/bin/ps', ['-p', pid, '-o', 'ppid='])).stdout.trim() !== String(process.pid)) return { state: 'unverified' };
      const comparison = compareChromeVersions(runningVersion, installedVersion);
      const result = {
        state: comparison < 0 ? 'restart-required' : comparison > 0 ? 'downgrade-risk' : 'current',
        runningVersion, installedVersion, publishedVersions, channel,
        // A release listing does not reveal updater policy or rollout eligibility.
        autoUpdate: 'unverified',
      };
      if (includeProof) {
        result.supervisorPid = process.pid;
        result.proof = createHash('sha256').update(JSON.stringify({ pid, supervisor: process.pid,
          endpoint: [health.cdpHost, health.cdpPort, config.healthPort], headless: health.headless,
          config: CONFIG_KEYS.map(key => [key, config[key]]), configuredExecutable, configuredBundle, processPath, bundleId: plist.CFBundleIdentifier,
          runningVersion, installedVersion, stamp: beforeStamp })).digest('hex');
      }
      return result;
    } catch {
      return { state: 'unverified' };
    }
  };
}

export const readBrowserUpdateStatus = createBrowserUpdateReader();
export const __testing = { createBrowserUpdateReader };
