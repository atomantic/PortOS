// PM2 owns only the copy launched by PortOS. A user-started server is
// discoverable, but these controls never stop it or replace its files.
import { cpus, release, totalmem } from 'node:os';
import { PORTS } from '../lib/ports.js';
import { sleep } from '../lib/fileCore.js';
import { MANAGED_RUNTIME_APPS } from '../lib/managedRuntimeApps.js';
import { createBundleDaemon, pm2ArgValue } from '../lib/managedDaemon.js';
import { ServerError } from '../lib/errorHandler.js';
import { isPortInUse } from '../lib/platform.js';
import {
  MKSERVE_BUNDLE, MKSERVE_MODEL, MKSERVE_VERSION, installPinnedMkserve, isMkserveRevision,
  mkserveInstallPaths, mkserveLaunchEnvironment, readMkserveInstall,
} from './mkserveRuntimeInstall.js';
import { clearJlistCache, execPm2, getAppStatusStrict } from './pm2.js';

export { MKSERVE_MODEL };
export const MKSERVE_APP = MANAGED_RUNTIME_APPS.mkserve.app;
const HOST = '127.0.0.1';
const PORT = PORTS.MKSERVE;
const ORIGIN = 'http://' + HOST + ':' + PORT;
const ENDPOINT = ORIGIN + '/v1';
const START_TIMEOUT_MS = 180_000;
const SUPPORTED_REASON = 'mkserve is supported on Apple M5 Max with macOS 26 or later and at least 36 GB of unified memory.';

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

const launchArgs = (paths) => [
  ...mkserveLaunchEnvironment(), paths.python, '-m', 'mkserve', 'serve', MKSERVE_MODEL,
  '--card', 'm5max', '--engine', 'offline-c', '--mode', 'native', '--prefill', 'fast',
  '--max-context', '32768', '--max-batch', '1', '--host', HOST, '--port', String(PORT),
  '--model-dir', paths.weights, '--workdir', paths.build,
];

function matchesLaunch(app) {
  if (!Array.isArray(app.args)) return false;
  const args = app.args;
  const bundle = pm2ArgValue(args, '--workdir')?.split('/').at(-2);
  const revision = pm2ArgValue(args, '--model-dir')?.split('/').at(-1);
  if (!isMkserveRevision(bundle) || !isMkserveRevision(revision)) return false;
  const paths = mkserveInstallPaths(bundle, revision);
  return args.includes(paths.python) && pm2ArgValue(args, '--model-dir') === paths.weights
    && pm2ArgValue(args, '--workdir') === paths.build && pm2ArgValue(args, '--host') === HOST
    && pm2ArgValue(args, '--port') === String(PORT) && args.includes(MKSERVE_MODEL);
}

const daemon = createBundleDaemon({
  appName: MKSERVE_APP,
  port: PORT,
  busy: () => error('Another mkserve operation is already running.'),
  matchesLaunch,
  pm2Unavailable: () => error('PortOS could not read its process manager. Check PortOS and retry.', 503, 'PM2_UNAVAILABLE'),
  nameInUse: () => error('An unmanaged PM2 process uses the mkserve service name. PortOS will not change it.', 409, 'NAME_IN_USE'),
  portInUse: () => error(`Port ${PORT} is in use. PortOS will not stop the existing listener.`, 409, 'PORT_IN_USE'),
  portCheckFailed: () => error(`Could not check whether mkserve port ${PORT} is free. Retry after checking the host.`, 503, 'PORT_CHECK_FAILED'),
  launchFailed: () => error('PM2 could not launch mkserve. Check the process manager and retry.', 503, 'START_FAILED'),
  deleteFailed: () => error('Could not stop the managed mkserve service. Check its PM2 status and retry.', 503, 'STOP_FAILED'),
  getAppStatusStrict, clearJlistCache, execPm2, isPortInUse, sleep,
  timeoutMs: START_TIMEOUT_MS,
  pollMs: 1000,
});

async function requireAppStatus() {
  const status = await daemon.requireStatus();
  daemon.assertNameAvailable(status);
  return status;
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

export async function getMkserveRuntimeStatus({ includeLogs = false } = {}) {
  const supported = supportsMkserve();
  const base = { supported, endpoint: ENDPOINT, installed: false, version: null, availableVersion: MKSERVE_VERSION, updateAvailable: false };
  if (!supported) return { ...base, state: 'unsupported', reason: SUPPORTED_REASON };
  const [installed, process, health] = await Promise.all([readMkserveInstall(), daemon.read(), probeMkserve()]);
  const { app, owned: managed, active } = process;
  const status = { ...base, installed: !!installed, version: installed?.version ?? null,
    updateAvailable: !!installed && installed.bundle !== MKSERVE_BUNDLE, recentLogs: includeLogs ? await daemon.recentLogs(process) : [] };
  const operation = daemon.operation();
  if (operation) return { ...status, managed, state: operation, ...health };
  if (health) {
    if (!managed || !active) return { ...status, ...health, managed: false, state: 'external' };
    return { ...status, ...health, managed: true, state: 'running' };
  }
  if (managed && active) return { ...status, managed: true, state: 'starting' };
  if (await daemon.hasListener()) return { ...status, managed: false, state: 'unrecognized', reason: 'Another service is using port ' + PORT + '.' };
  if (managed && app.status === 'errored') {
    return { ...status, managed: true, state: 'error', reason: 'mkserve exited. Check its PM2 logs before restarting.' };
  }
  return { ...status, managed, state: installed ? 'stopped' : 'missing' };
}

function runOperation(state, run) {
  if (!supportsMkserve()) throw error(SUPPORTED_REASON, 400, 'UNSUPPORTED_PLATFORM');
  return daemon.withOperation(state, run);
}

export function installMkserve({ onProgress: progress } = {}) {
  return runOperation('installing', async (setOperation) => {
    const installed = await readMkserveInstall();
    if (installed?.bundle === MKSERVE_BUNDLE) return { success: true, message: 'mkserve is up to date' };
    if (installed) setOperation('updating');
    const { active } = await requireAppStatus();
    if (active) throw error('Stop the managed mkserve server before updating or repairing it.');
    await installPinnedMkserve((message) => onProgress(progress, message), installed);
    return { success: true, message: installed ? 'mkserve updated' : 'mkserve installed' };
  });
}

const waitUntilReady = () => daemon.waitUntilReady({
  probe: async () => {
    const live = await probeMkserve();
    return live?.engine === 'offline-c' && live.maxContext === 32768;
  },
  exited: (status) => {
    daemon.assertNameAvailable(status);
    return error('mkserve exited before becoming ready. Check its PM2 logs and retry.', 503, 'START_FAILED');
  },
  timedOut: () => error('mkserve is still loading. Check its status, or stop it before retrying.', 503, 'START_TIMEOUT'),
});

export function startMkserveServer({ onProgress: progress } = {}) {
  return runOperation('starting', async () => {
    const paths = await readMkserveInstall();
    if (!paths) throw error('Install mkserve and its checkpoint from the Runtimes card before starting it.', 400, 'NOT_INSTALLED');
    const status = await requireAppStatus();
    if (status.active) {
      await waitUntilReady();
      return { success: true, message: 'mkserve is already running' };
    }
    await daemon.assertPortFree();
    if (status.owned) {
      await daemon.remove(status, { timeoutMs: 60_000 });
      const { app } = await requireAppStatus();
      if (app.status !== 'not_found') throw error('A second process uses the mkserve service name. PortOS will not change it.', 409, 'NAME_IN_USE');
    }
    onProgress(progress, 'Starting mkserve with the verified local checkpoint…');
    await daemon.launch(launchArgs(paths), { cwd: paths.source, killTimeoutMs: 45_000 });
    await waitUntilReady();
    return { success: true, message: 'mkserve started' };
  });
}

export function stopMkserveServer() {
  return runOperation('stopping', async () => {
    const status = await requireAppStatus();
    if (status.app.status === 'not_found') {
      if (await daemon.hasListener()) throw error('The listener was not started by PortOS and cannot be stopped here.', 409, 'EXTERNAL_PROCESS');
      return { success: true, message: 'mkserve is not running' };
    }
    await daemon.remove(status, { timeoutMs: 60_000 });
    if (await daemon.hasListener()) throw error('The managed process was removed, but port ' + PORT + ' is still in use.', 409, 'PORT_IN_USE');
    return { success: true, message: 'mkserve stopped' };
  });
}
