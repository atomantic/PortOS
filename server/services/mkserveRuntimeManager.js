// PM2 owns only the copy launched by PortOS. A user-started server is
// discoverable, but these controls never stop it or replace its files.
import { cpus, release, totalmem } from 'node:os';
import { PORTS } from '../lib/ports.js';
import { sleep } from '../lib/fileCore.js';
import { ServerError } from '../lib/errorHandler.js';
import { isPortInUse } from '../lib/platform.js';
import {
  MKSERVE_BUNDLE, MKSERVE_MODEL, MKSERVE_VERSION, installPinnedMkserve, isMkserveRevision,
  mkserveInstallPaths, mkserveLaunchEnvironment, readMkserveInstall,
} from './mkserveRuntimeInstall.js';
import { clearJlistCache, execPm2, getAppStatusStrict } from './pm2.js';

export { MKSERVE_MODEL };
export const MKSERVE_APP = 'portos-mkserve';
const HOST = '127.0.0.1';
const PORT = PORTS.MKSERVE;
const ORIGIN = 'http://' + HOST + ':' + PORT;
const ENDPOINT = ORIGIN + '/v1';
const START_TIMEOUT_MS = 180_000;
const SUPPORTED_REASON = 'mkserve is supported on Apple M5 Max with macOS 26 or later and at least 36 GB of unified memory.';
const ACTIVE = new Set(['online', 'launching', 'stopping', 'waiting restart']);
let operation = null;

function supportsMkserve() {
  return process.platform === 'darwin' && process.arch === 'arm64'
    && Number(release().split('.')[0]) >= 25
    && cpus()[0]?.model === 'Apple M5 Max' && totalmem() >= 36 * 2 ** 30;
}

function error(message, status = 409, suffix = 'BUSY') {
  return new ServerError(message, { status, code: 'MKSERVE_' + suffix });
}

function onProgress(callback, message) {
  callback?.({ event: 'progress', message });
}

function runOperation(state, action) {
  if (!supportsMkserve()) throw error(SUPPORTED_REASON, 400, 'UNSUPPORTED_PLATFORM');
  if (operation) throw error('Another mkserve operation is already running.');
  operation = state;
  return action().finally(() => { operation = null; });
}

const launchArgs = (paths) => [
  ...mkserveLaunchEnvironment(), paths.python, '-m', 'mkserve', 'serve', MKSERVE_MODEL,
  '--card', 'm5max', '--engine', 'offline-c', '--mode', 'native', '--prefill', 'fast',
  '--max-context', '32768', '--max-batch', '1', '--host', HOST, '--port', String(PORT),
  '--model-dir', paths.weights, '--workdir', paths.build,
];

function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function isManaged(app) {
  if (!Number.isSafeInteger(app?.pm_id) || app.pm_id < 0 || !Array.isArray(app.args)) return false;
  const args = app.args;
  const bundle = option(args, '--workdir')?.split('/').at(-2);
  const revision = option(args, '--model-dir')?.split('/').at(-1);
  if (!isMkserveRevision(bundle) || !isMkserveRevision(revision)) return false;
  const paths = mkserveInstallPaths(bundle, revision);
  return args.includes(paths.python) && option(args, '--model-dir') === paths.weights
    && option(args, '--workdir') === paths.build && option(args, '--host') === HOST
    && option(args, '--port') === String(PORT) && args.includes(MKSERVE_MODEL);
}

async function requireAppStatus() {
  clearJlistCache();
  const app = await getAppStatusStrict(MKSERVE_APP);
  if (!app) throw error('PortOS could not read its process manager. Check PortOS and retry.', 503, 'PM2_UNAVAILABLE');
  if (app.status !== 'not_found' && !isManaged(app)) {
    throw error('An unmanaged PM2 process uses the mkserve service name. PortOS will not change it.', 409, 'NAME_IN_USE');
  }
  return app;
}

async function probeMkserve() {
  const probe = async (path) => {
    const response = await fetch(ORIGIN + path, { redirect: 'error', signal: AbortSignal.timeout(1500) }).catch(() => null);
    if (!response?.ok) {
      await response?.body?.cancel().catch(() => null);
      return null;
    }
    return response.json().catch(() => null);
  };
  const health = await probe('/health');
  if (health?.status !== 'ok' || typeof health.engine !== 'string') return null;
  const models = await probe('/v1/models');
  const found = Array.isArray(models?.data) && models.data.find((item) =>
    item?.owned_by === 'mkserve' && item.engine === health.engine && item.id === MKSERVE_MODEL);
  return found ? { model: found.id, engine: health.engine, maxContext: health.max_context } : null;
}

async function portInUse() {
  return isPortInUse(PORT).catch(() => {
    throw error('Could not check whether mkserve port ' + PORT + ' is free. Retry after checking the host.', 503, 'PORT_CHECK_FAILED');
  });
}

export async function getMkserveRuntimeStatus() {
  const supported = supportsMkserve();
  const base = { supported, endpoint: ENDPOINT, installed: false, version: null, availableVersion: MKSERVE_VERSION, updateAvailable: false };
  if (!supported) return { ...base, state: 'unsupported', reason: SUPPORTED_REASON };
  const [installed, app, health] = await Promise.all([readMkserveInstall(), getAppStatusStrict(MKSERVE_APP), probeMkserve()]);
  const status = { ...base, installed: !!installed, version: installed?.version ?? null,
    updateAvailable: !!installed && installed.bundle !== MKSERVE_BUNDLE };
  const managed = isManaged(app);
  if (operation) return { ...status, managed, state: operation, ...health };
  if (health) {
    if (!managed || !ACTIVE.has(app.status)) return { ...status, ...health, managed: false, state: 'external' };
    return { ...status, ...health, managed: true, state: 'running' };
  }
  if (managed && ACTIVE.has(app.status)) return { ...status, managed: true, state: 'starting' };
  if (await portInUse()) return { ...status, managed: false, state: 'unrecognized', reason: 'Another service is using port ' + PORT + '.' };
  if (managed && app.status === 'errored') {
    return { ...status, managed: true, state: 'error', reason: 'mkserve exited. Check its PM2 logs before restarting.' };
  }
  return { ...status, managed, state: installed ? 'stopped' : 'missing' };
}

export function installMkserve({ onProgress: progress } = {}) {
  return runOperation('installing', async () => {
    const installed = await readMkserveInstall();
    if (installed?.bundle === MKSERVE_BUNDLE) return { success: true, message: 'mkserve is up to date' };
    if (installed) operation = 'updating';
    const app = await requireAppStatus();
    if (isManaged(app) && ACTIVE.has(app.status)) throw error('Stop the managed mkserve server before updating or repairing it.');
    await installPinnedMkserve((message) => onProgress(progress, message));
    return { success: true, message: installed ? 'mkserve updated' : 'mkserve installed' };
  });
}

async function removeManaged(app) {
  await execPm2(['delete', String(app.pm_id)], { timeoutMs: 60_000 }).catch(() => {
    throw error('Could not stop the managed mkserve service. Check its PM2 status and retry.', 503, 'STOP_FAILED');
  });
  clearJlistCache();
}

async function waitUntilReady() {
  const deadline = Date.now() + START_TIMEOUT_MS;
  do {
    const app = await requireAppStatus();
    if (!ACTIVE.has(app.status)) throw error('mkserve exited before becoming ready. Check its PM2 logs and retry.', 503, 'START_FAILED');
    const live = await probeMkserve();
    if (live?.engine === 'offline-c' && live.maxContext === 32768) return;
    await sleep(1000);
  } while (Date.now() < deadline);
  throw error('mkserve is still loading. Check its status, or stop it before retrying.', 503, 'START_TIMEOUT');
}

export function startMkserveServer({ onProgress: progress } = {}) {
  return runOperation('starting', async () => {
    const paths = await readMkserveInstall();
    if (!paths) throw error('Install mkserve and its checkpoint from the Runtimes card before starting it.', 400, 'NOT_INSTALLED');
    const app = await requireAppStatus();
    if (ACTIVE.has(app.status)) {
      await waitUntilReady();
      return { success: true, message: 'mkserve is already running' };
    }
    if (await portInUse()) throw error('Port ' + PORT + ' is in use. PortOS will not stop the existing listener.', 409, 'PORT_IN_USE');
    if (app.status !== 'not_found') {
      await removeManaged(app);
      const remaining = await requireAppStatus();
      if (remaining.status !== 'not_found') throw error('A second process uses the mkserve service name. PortOS will not change it.', 409, 'NAME_IN_USE');
    }
    onProgress(progress, 'Starting mkserve with the verified local checkpoint…');
    await execPm2([
      'start', '/usr/bin/env', '--name', MKSERVE_APP, '--cwd', paths.source, '--interpreter', 'none',
      '--no-autorestart', '--kill-timeout', '45000', '--', ...launchArgs(paths),
    ]).catch(() => { throw error('PM2 could not launch mkserve. Check the process manager and retry.', 503, 'START_FAILED'); });
    await waitUntilReady();
    return { success: true, message: 'mkserve started' };
  });
}

export function stopMkserveServer() {
  return runOperation('stopping', async () => {
    const app = await requireAppStatus();
    if (app.status === 'not_found') {
      if (await portInUse()) throw error('The listener was not started by PortOS and cannot be stopped here.', 409, 'EXTERNAL_PROCESS');
      return { success: true, message: 'mkserve is not running' };
    }
    await removeManaged(app);
    if (await portInUse()) throw error('The managed process was removed, but port ' + PORT + ' is still in use.', 409, 'PORT_IN_USE');
    return { success: true, message: 'mkserve stopped' };
  });
}
