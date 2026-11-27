/** Watch managed PM2 daemons, collect bounded logs and wait for startup, readiness and port release. */

import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ServerError } from './errorHandler.js';
import { daemonReleaseReason } from './idleDaemonReaper.js';

/** Same cap both managers used, and what the launcher cards render. */
const DEFAULT_MAX_LINES = 100;

/**
 * A bounded, timestamped ring buffer of a daemon's recent output.
 *
 * `withPm2Logs` does NOT fold the PM2 output into the buffer: PM2 owns those
 * lines and re-reads them on every status call, so remembering them here would
 * grow a second copy that outlives the process they came from. It returns the
 * merged VIEW a status response renders.
 *
 * @param {{maxLines?: number}} [options]
 */
export function createDaemonLogBuffer({ maxLines = DEFAULT_MAX_LINES } = {}) {
  let lines = [];

  const append = (line) => {
    if (!line) return;
    const text = String(line).trimEnd();
    if (!text) return;
    lines.push(`[${new Date().toISOString()}] ${text}`);
    if (lines.length > maxLines) lines = lines.slice(-maxLines);
  };

  return {
    append,
    maxLines,
    reset: () => { lines = []; },
    snapshot: () => [...lines],
    /**
     * This buffer's lines followed by anything in `pm2Output` it does not
     * already hold, capped to the same budget.
     * @param {string} pm2Output combined stdout + stderr from `pm2 logs`
     * @returns {string[]}
     */
    withPm2Logs(pm2Output) {
      const merged = [...lines];
      const seen = new Set(merged);
      for (const line of String(pm2Output || '').split('\n').map((l) => l.trimEnd()).filter(Boolean)) {
        if (seen.has(line)) continue;
        merged.push(line);
        seen.add(line);
      }
      return merged.length > maxLines ? merged.slice(-maxLines) : merged;
    },
  };
}

/** Tail a verified PM2 process ID so a same-named process's output stays private. */
export async function readManagedPm2LogTail(pmId, execPm2) {
  const maxLines = 40;
  const result = await execPm2(['logs', String(pmId), '--nostream', '--lines', String(maxLines)], { timeoutMs: 3000 }).catch(() => null);
  return `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.split('\n')
    .map((line) => line.trimEnd()).filter(Boolean).slice(-maxLines)
    .map((line) => line.slice(-2000));
}

/**
 * The value following `flag` in a PM2 process's recorded argv, or `null`.
 *
 * `null` means the flag was NOT on the launch line, which is distinct from a
 * flag whose value happens to be falsy — a caller reconstructing a config must
 * leave an absent flag off a relaunch rather than substituting a default the
 * daemon never saw.
 *
 * @param {string[]|string} args PM2's `args` (an array, or the space-joined string it sometimes reports)
 * @param {string} flag
 * @returns {string|null}
 */
export function pm2ArgValue(args, flag) {
  const list = Array.isArray(args) ? args : String(args || '').split(' ');
  const idx = list.indexOf(flag);
  return idx !== -1 && idx + 1 < list.length ? list[idx + 1] : null;
}

/**
 * Shared watcher for a local daemon PortOS owns through PM2.
 *
 * Managers supply their daemon-specific launch-line parser and endpoint probe;
 * the watcher owns the common PM2 lifecycle, adoption, status, bounded logs,
 * and stop-then-relaunch port-release wait. State remains in the manager through
 * `getConfig` / `setConfig`, so install and tuning paths can keep their domain
 * rules without reaching into this mechanism.
 *
 * Dependency callbacks are explicit both to keep this module side-effect free
 * and to preserve the managers' existing test seams around PM2 and networking.
 */
export function createDaemonWatcher({
  appName,
  defaultHost = '127.0.0.1',
  defaultPort,
  endpointFor,
  parseConfigFromArgs,
  probe,
  isPortInUse,
  sleep,
  getConfig,
  setConfig,
  getLastExitError,
  setLastExitError,
  getAppStatus,
  clearStatusCache,
  getSavedProcessNames,
  execPm2,
  getPortReleaseTimeoutMs = () => DEFAULT_PORT_RELEASE_TIMEOUT_MS,
  preserveConfigOnReadFailure = false,
  maxLogLines,
}) {
  const logs = createDaemonLogBuffer({ maxLines: maxLogLines });

  const recoverConfig = (pm2Status) => {
    const current = getConfig();
    if (current || pm2Status?.status !== 'online' || !pm2Status.args) return current;
    const recovered = parseConfigFromArgs(pm2Status.args);
    setConfig(recovered);
    return recovered;
  };

  const readLaunch = async () => {
    const pm2Status = await getAppStatus(appName);
    if (pm2Status === null) return { managed: false, config: null, readFailed: true };
    if (pm2Status.status !== 'online') return { managed: false, config: null, readFailed: false };
    return { managed: true, config: recoverConfig(pm2Status), readFailed: false };
  };

  const endpoint = () => endpointFor(getConfig());

  const getStatusBase = async ({ installed, includeLogs = true }) => {
    const [pm2Status, savedApps] = await Promise.all([getAppStatus(appName), getSavedProcessNames()]);
    const isReadFailed = pm2Status === null;
    const isManagedActive = pm2Status?.status === 'online';
    const config = recoverConfig(pm2Status);
    const resolvedEndpoint = endpointFor(config);
    const reachable = await probe(resolvedEndpoint);
    const pm2Logs = includeLogs && pm2Status && pm2Status.status !== 'not_found'
      ? await execPm2(['logs', appName, '--nostream', '--lines', String(logs.maxLines)]).catch(() => null)
      : null;

    return {
      installed,
      running: isManagedActive || reachable,
      managed: isReadFailed ? null : isManagedActive,
      pid: isManagedActive ? (pm2Status.pid || null) : null,
      host: config?.host || defaultHost,
      port: config?.port ?? defaultPort,
      endpoint: resolvedEndpoint,
      config: isManagedActive || (isReadFailed && preserveConfigOnReadFailure) ? config : null,
      runAtStartup: savedApps === null ? null : savedApps.includes(appName),
      recentLogs: includeLogs ? logs.withPm2Logs(`${pm2Logs?.stdout || ''}\n${pm2Logs?.stderr || ''}`) : [],
      lastExitError: isReadFailed ? 'Failed to read PM2 status' : includeLogs ? getLastExitError() : null,
      releaseReason: isManagedActive ? null : daemonReleaseReason(appName),
    };
  };

  const waitForPortRelease = async (port) => {
    const deadline = Date.now() + getPortReleaseTimeoutMs();
    while (Date.now() < deadline && await isPortInUse(port)) await sleep(200);
  };

  const assertPortFree = async ({ host, port, label, codePrefix, portAdvice, beforeProbe }) => {
    const proc = await getAppStatus(appName);
    if (proc?.status === 'online') {
      throw new ServerError(`${label} is already running with PID ${proc.pid}`, { status: 409 });
    }

    beforeProbe?.();
    const resolvedEndpoint = `http://${host}:${port}/v1`;
    if (await probe(resolvedEndpoint)) {
      throw new ServerError(`Port ${port} is already in use by an active server at ${resolvedEndpoint}`, { status: 409 });
    }
    if (await isPortInUse(port)) {
      throw new ServerError(`Port ${port} is already in use on ${host}. ${portAdvice}`, {
        status: 409,
        code: `${codePrefix}_PORT_IN_USE`,
      });
    }
    return resolvedEndpoint;
  };

  const launch = async ({
    binaryPath, args, endpoint, waitMs, pollMs, logs: logFiles, label, codePrefix,
    describeExit, trimExitOutput, onStarted,
  }) => {
    await execPm2(['delete', appName]).catch(() => {});
    clearStatusCache();

    const logsReset = await logFiles.reset();
    const { stdout, stderr } = logFiles.files();
    await execPm2([
      'start', binaryPath,
      '--name', appName,
      '--interpreter', 'none',
      '--no-autorestart',
      '--output', stdout,
      '--error', stderr,
      '--',
      ...args,
    ]);
    clearStatusCache();

    const deadline = Date.now() + waitMs;
    let online = false;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      clearStatusCache();
      const proc = await getAppStatus(appName);
      if (isDeadPm2Status(proc)) {
        // PM2 appends across launches. Without truncation its tail may only
        // describe a prior process, so use the current in-memory lines instead.
        const lines = logsReset ? await readPm2ExitLines({ appName, execPm2, trimOutput: trimExitOutput }) : [];
        for (const line of lines) logs.append(line);
        const tail = (lines.length ? lines : logs.snapshot()).slice(-4).join(' | ');
        const status = `PM2 status: ${proc.status}`;
        setLastExitError(status);
        const message = describeExit?.(lines) || `${label} exited immediately (${status}).`;

        await execPm2(['delete', appName]).catch(() => {});
        clearStatusCache();
        setConfig(null);
        throw new ServerError(`${message}${tail ? ` Last output: ${tail}` : ''}`, {
          status: 500,
          code: `${codePrefix}_EXITED`,
        });
      }
      online = await probe(endpoint);
      if (online) break;
    }

    await onStarted?.();
    const finalProc = await getAppStatus(appName);
    return {
      success: true,
      running: true,
      managed: true,
      pid: finalProc?.pid || null,
      endpoint,
      online,
      config: getConfig(),
    };
  };

  const stop = async ({ label, onStopped }) => {
    const proc = await getAppStatus(appName);
    if (proc?.status !== 'online') {
      const resolvedEndpoint = endpoint();
      if (await probe(resolvedEndpoint)) {
        return {
          success: false,
          code: 'EXTERNAL_PROCESS_RUNNING',
          message: `An external process is listening on ${resolvedEndpoint}. It was not started by PortOS and cannot be stopped here.`,
        };
      }
      return { success: true, message: `${label} is not running` };
    }

    logs.append(`Stopping ${appName}`);
    await execPm2(['delete', appName]).catch((err) => {
      throw new ServerError(`Failed to stop ${label}: ${err.message}`, { status: 500 });
    });
    clearStatusCache();
    setConfig(null);
    onStopped?.();
    return { success: true, message: `${label} stopped` };
  };

  const assertStoppedForUninstall = async ({ label, codePrefix, savedPort }) => {
    clearStatusCache();
    const app = await getAppStatus(appName);
    if (!app) {
      throw new ServerError(`PortOS could not verify that ${label} is stopped. Check PM2 and retry.`, {
        status: 503, code: `${codePrefix}_PM2_UNAVAILABLE`,
      });
    }
    const inUse = () => new ServerError(`Stop ${label} and free its configured port before uninstalling.`, {
      status: 409, code: `${codePrefix}_IN_USE`,
    });
    if (!['not_found', 'stopped', 'errored'].includes(app.status)) throw inUse();
    const ports = new Set([defaultPort, savedPort, getConfig()?.port, parseConfigFromArgs(app.args)?.port].filter(Boolean));
    const listening = await Promise.all([...ports].map((port) => isPortInUse(port)));
    if (listening.some(Boolean)) throw inUse();
  };

  return {
    appendLog: logs.append,
    assertStoppedForUninstall,
    assertPortFree,
    endpoint,
    getStatusBase,
    launch,
    readLaunch,
    resetLogs: logs.reset,
    stop,
    waitForPortRelease,
  };
}

const DEFAULT_PORT_RELEASE_TIMEOUT_MS = 5000;

const isDeadPm2Status = (proc) => ['errored', 'stopped', 'not_found'].includes(proc?.status);

async function readPm2ExitLines({ appName, execPm2, lines = 15, trimOutput = false }) {
  const result = await execPm2(['logs', appName, '--nostream', '--lines', String(lines)]).catch(() => null);
  const output = String(result?.stderr || result?.stdout || '');
  return (trimOutput ? output.trim() : output).split('\n').map((line) => line.trimEnd()).filter(Boolean);
}

/**
 * Per-launch truncated PM2 `--output`/`--error` files. PM2 appends to its
 * configured files across process deletion, so without a reset a dead launch's
 * exit tail is diagnosed from the PREVIOUS launch's output.
 *
 * `reset()` resolves `false` when either file could not be truncated, so the
 * caller can disable log-based diagnosis for that launch instead of trusting
 * stale text. `setForTests` swaps the paths (a falsy argument restores them).
 *
 * @param {string} appName PM2 app name, used to derive the file names
 * @returns {{files: () => {stdout: string, stderr: string}, reset: () => Promise<boolean>, setForTests: (files?: {stdout?: string, stderr?: string}) => void}}
 */
export function createDaemonLogFiles(appName) {
  const defaults = {
    stdout: join(tmpdir(), `${appName}-out.log`),
    stderr: join(tmpdir(), `${appName}-error.log`),
  };
  let current = defaults;
  return {
    files: () => current,
    reset: async () => {
      const results = await Promise.all(
        Object.entries(current).map(([stream, path]) => (
          writeFile(path, '')
            .then(() => true)
            .catch((error) => {
              console.error(`❌ ${appName}: could not reset ${stream} startup log (${error?.code || 'unknown'}); bootstrap diagnosis disabled for this launch`);
              return false;
            })
        )),
      );
      return results.every(Boolean);
    },
    setForTests: (files) => {
      current = files ? { stdout: files.stdout || defaults.stdout, stderr: files.stderr || defaults.stderr } : defaults;
    },
  };
}

// The injected sleeper is not required to be cancellable. A real timer is
// cleared on abort so a multi-minute readiness budget does not keep running.
const sleepOrAbort = (sleep, ms, signal) => {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', finish);
      resolve();
    }, ms);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
  });
};

/**
 * Block until the daemon answers, or until it is proven dead. Polls PM2
 * alongside the endpoint, because "still loading" and "already died" look
 * identical from the endpoint alone and cost wildly different amounts of time
 * to wait out.
 *
 * @returns {Promise<{ready: boolean, reason: string|null, aborted?: boolean}>}
 */
export async function waitForDaemonReady({
  endpoint,
  label,
  probe,
  getStatusStrict,
  clearStatusCache = () => {},
  exitTail,
  sleep,
  timeoutMs,
  pollMs,
  signal,
}) {
  const aborted = () => (signal?.aborted
    ? { ready: false, aborted: true, reason: `${label} readiness wait was aborted` }
    : null);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stopped = aborted();
    if (stopped) return stopped;
    if (await probe(endpoint)) return { ready: true, reason: null };
    clearStatusCache();
    const proc = await getStatusStrict();
    if (isDeadPm2Status(proc)) {
      const tail = exitTail ? await exitTail(proc.status) : `PM2 status: ${proc.status}`;
      return { ready: false, reason: `${label} exited while loading (${tail})` };
    }
    await sleepOrAbort(sleep, pollMs, signal);
  }
  return aborted() || { ready: false, reason: `${label} relaunched but never answered on its port` };
}

/**
 * The last few lines PM2 has for a dead daemon, folded into the manager's own
 * log buffer and summarized alongside the PM2 status word.
 *
 * Shared because `startMtplxServer`'s relaunch-wait loop and
 * `ensureSlotstreamRunning`'s used to diagnose the identical failure two
 * different ways: MTPLX's wait loop tailed the PM2 log (6a9348344, 7480e0476),
 * Slotstream's reported only `PM2 status: errored`. A launch line that dies
 * mid-load deserves the same diagnosis regardless of which daemon it was.
 *
 * @param {{appName: string, execPm2: (args: string[]) => Promise<{stdout?: string, stderr?: string}>, appendLog: (line: string) => void, lines?: number, tailLines?: number}} options
 * @returns {(status: string) => Promise<string>}
 */
export function createPm2ExitTail({ appName, execPm2, appendLog, lines = 15, tailLines = 4 }) {
  return async (status) => {
    const outputLines = await readPm2ExitLines({ appName, execPm2, lines });
    for (const line of outputLines) appendLog(line);
    const tail = outputLines.slice(-tailLines).join(' | ');
    return tail ? `PM2 status: ${status} — ${tail}` : `PM2 status: ${status}`;
  };
}
