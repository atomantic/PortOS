/** Manage owned PM2 bundles and serialize on-demand launches for idle-managed daemons. */

import { localEndpointPort } from './localEndpoint.js';
import { isLocalEndpointBusy, localEndpointsSharePort, onLocalEndpointSettled } from './localLlmConcurrency.js';
import { createSingleFlight } from './singleFlight.js';
import { readManagedPm2LogTail, waitForDaemonReady } from './daemonWatcher.js';
import { idleWindowMs, markDaemonUsed, registerIdleDaemon } from './idleDaemonReaper.js';

const settledUnsubscribers = new Set();

export function resetOnDemandSubscriptionsForTests() {
  for (const unsubscribe of settledUnsubscribers) unsubscribe();
  settledUnsubscribers.clear();
}

const ACTIVE_BUNDLE_STATUSES = new Set(['online', 'launching', 'waiting restart', 'stopping']);

/**
 * Lifecycle for a pinned bundle whose launch arguments prove ownership.
 * Mutations fail closed on an unreadable PM2 list and address owned entries by
 * ID. Managers supply bundle identity, launch settings and readiness checks.
 */
export function createBundleDaemon({
  appName,
  busy,
  matchesLaunch,
  pm2Unavailable,
  nameInUse,
  portInUse,
  portCheckFailed,
  unsupportedStop = nameInUse,
  launchFailed,
  deleteFailed,
  getAppStatusStrict,
  clearJlistCache,
  execPm2,
  isPortInUse,
  port,
  sleep,
  timeoutMs,
  pollMs,
}) {
  let operation = null;

  const read = async (identity) => {
    const app = await getAppStatusStrict(appName);
    const owned = Number.isSafeInteger(app?.pm_id) && app.pm_id >= 0 && matchesLaunch(app, identity);
    return { app, owned, active: ACTIVE_BUNDLE_STATUSES.has(app?.status) };
  };

  const assertNameAvailable = ({ app, owned }) => {
    if (app.status !== 'not_found' && !owned) throw nameInUse();
  };

  const requireStatus = async (identity) => {
    clearJlistCache();
    const status = await read(identity);
    if (!status.app) throw pm2Unavailable();
    return status;
  };

  const hasListener = async () => isPortInUse(port).catch((err) => {
    throw portCheckFailed ? portCheckFailed() : err;
  });

  return {
    read,
    requireStatus,
    assertNameAvailable,
    hasListener,
    async assertPortFree() {
      if (await hasListener()) throw portInUse();
    },
    withOperation(state, run) {
      if (operation) throw busy();
      operation = state;
      return Promise.resolve()
        .then(() => run((next) => { operation = next; }))
        .finally(() => { operation = null; });
    },
    operation: () => operation,
    recentLogs: ({ app, owned }) => owned ? readManagedPm2LogTail(app.pm_id, execPm2) : [],
    async remove({ app, owned }, options) {
      if (!owned) throw unsupportedStop();
      const args = ['delete', String(app.pm_id)];
      await (options ? execPm2(args, options) : execPm2(args)).catch((err) => {
        throw deleteFailed ? deleteFailed() : err;
      });
      clearJlistCache();
    },
    async launch(args, { cwd, killTimeoutMs, force }) {
      await execPm2([
        'start', '/usr/bin/env', '--name', appName, ...(cwd ? ['--cwd', cwd] : []),
        '--interpreter', 'none', '--no-autorestart', '--kill-timeout', String(killTimeoutMs),
        ...(force ? ['--force'] : []), '--', ...args,
      ]).catch((err) => {
        throw launchFailed ? launchFailed() : err;
      });
    },
    async waitUntilReady({ identity, probe, exited, timedOut }) {
      const deadline = performance.now() + timeoutMs;
      do {
        // Verify ownership before crediting a response on the preset port.
        const status = await requireStatus(identity);
        if (!status.owned || !status.active) throw exited(status);
        if (await probe()) return;
        await sleep(pollMs);
      } while (performance.now() < deadline);
      throw timedOut();
    },
  };
}

/**
 * Shared on-demand wake mechanism for a local daemon that stops on idle
 * (`registerIdleDaemon`) and must come back up lazily for the next
 * request. Extracted from `mtplxServerManager.js` and `slotstreamServerManager.js`,
 * which had drifted into two copies with different bugs (#8105): MTPLX's port
 * arm never matched (a string compared with `===` to a number), and only
 * MTPLX's death-detecting readiness loop carried a PM2 log tail.
 *
 * Mechanism only, same contract as `createDaemonWatcher`: what a launch
 * line MEANS (which knobs it carries, how a saved one merges with a live one)
 * stays in `resolveLaunch`, which each manager supplies.
 *
 * @param {{
 *   appName: string,
 *   label: string,
 *   emoji: string,
 *   readSection: () => Promise<object|null>,
 *   endpointFor: (config: object|null) => string,
 *   probe: (endpoint: string) => Promise<boolean>,
 *   start: (config: object) => Promise<object>,
 *   stop: () => Promise<unknown>,
 *   getStatusStrict: () => Promise<object|null>,
 *   clearStatusCache?: () => void,
 *   exitTail?: (status: string) => Promise<string>,
 *   resolveLaunch: (current: object|null, saved: {model: string|null, port: number|null, raw: object}) => object,
 *   getConfig?: () => object|null,
 *   parseConfigFromArgs?: (args: string[]|string) => object|null,
 *   sleep: (ms: number) => Promise<void>,
 *   getRelaunchReadyTimeoutMs: () => number,
 *   getRelaunchPollMs: () => number,
 * }} options
 */
export function createOnDemandDaemon({
  appName,
  label,
  emoji,
  readSection,
  endpointFor,
  probe,
  start,
  stop,
  getStatusStrict,
  clearStatusCache = () => {},
  exitTail,
  resolveLaunch,
  getConfig = () => null,
  parseConfigFromArgs = () => null,
  sleep,
  getRelaunchReadyTimeoutMs,
  getRelaunchPollMs,
}) {
  // Test seam, same shape as each manager's own `_set*OverrideForTests`: a
  // suite must not depend on whether this developer has an idle window
  // configured. `null` means "read settings"; both live here now rather than
  // in the manager, since `registerIdle` below is what reads them.
  let idleMinutesOverride = null;
  let keepLoadedOverride = null;

  const configuredIdleMinutes = async () => {
    if (idleMinutesOverride !== null) return idleMinutesOverride;
    const section = await readSection();
    const raw = Number(section?.idleMinutes);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  };

  const configuredKeepLoaded = async () => {
    if (keepLoadedOverride !== null) return keepLoadedOverride;
    const section = await readSection();
    // Legacy fallback: `pinned` was the setting's name before `keepLoaded`.
    return Boolean(section?.keepLoaded ?? section?.pinned);
  };

  let inFlightStarts = 0;
  // Explicit starts return after a short HTTP budget while weights are still
  // loading. This stays raised until the endpoint answers or PM2 leaves online.
  let inFlightLoads = 0;
  // In-memory launch config is null after a PortOS restart until something
  // recovers argv. The provider slot is the port the process is actually on.
  let boundEndpoint = null;

  const portEndpoint = (config) => (
    Number.isFinite(Number(config?.port)) ? endpointFor({ port: Number(config.port) }) : null
  );
  const busyEndpoint = () => portEndpoint(getConfig()) || boundEndpoint || endpointFor(getConfig());
  const isBusy = () => inFlightStarts > 0 || inFlightLoads > 0 || isLocalEndpointBusy(busyEndpoint());

  let unsubscribeSettled = () => {};

  /** The launch line last saved on the settings card, sanitized. */
  const savedLaunchConfig = async () => {
    const section = await readSection();
    const launch = section?.launch || {};
    return {
      model: typeof launch.model === 'string' && launch.model.trim() ? launch.model.trim() : null,
      port: launch.port != null && Number.isFinite(Number(launch.port)) ? Number(launch.port) : null,
      // Whatever else the daemon's own knobs need (MTPLX's `tuning`,
      // Slotstream's `memoryGb`) — shaped and normalized by `resolveLaunch`,
      // never generically here, since only the manager knows that shape.
      raw: launch,
    };
  };

  const refreshBoundEndpoint = async (knownStatus) => {
    const live = portEndpoint(getConfig());
    if (live) {
      boundEndpoint = live;
      return;
    }
    const status = knownStatus ?? await Promise.resolve(getStatusStrict()).catch(() => null);
    if (status?.status === 'online' && status.args) {
      try {
        const fromArgs = portEndpoint(parseConfigFromArgs(status.args));
        if (fromArgs) {
          boundEndpoint = fromArgs;
          return;
        }
      } catch {
        // Unparseable argv is not a port. The saved launch is the next source.
      }
    }
    const saved = await savedLaunchConfig().catch(() => null);
    if (saved?.port != null) boundEndpoint = endpointFor({ port: saved.port });
  };

  // Resolves once, then stays sync: the reaper's last busy check cannot await.
  const ensureBoundEndpoint = () => (
    portEndpoint(getConfig()) || boundEndpoint ? Promise.resolve() : refreshBoundEndpoint()
  );

  const registerIdle = () => {
    unsubscribeSettled();
    settledUnsubscribers.delete(unsubscribeSettled);
    unsubscribeSettled = onLocalEndpointSettled((endpoint) => {
      if (localEndpointsSharePort(endpoint, busyEndpoint())) markDaemonUsed(appName);
    });
    settledUnsubscribers.add(unsubscribeSettled);
    registerIdleDaemon({
      name: appName,
      getIdleMs: async () => idleWindowMs(await configuredIdleMinutes()),
      isPinned: async () => configuredKeepLoaded(),
      isRunning: async () => Boolean((await getStatusStrict())?.status === 'online'),
      isBusy,
      warm: ensureBoundEndpoint,
      stop: () => stop(),
    });
  };

  const waitForReady = (endpoint, { signal } = {}) => waitForDaemonReady({
    endpoint,
    label,
    probe,
    getStatusStrict,
    clearStatusCache,
    exitTail,
    sleep,
    timeoutMs: getRelaunchReadyTimeoutMs(),
    pollMs: getRelaunchPollMs(),
    signal,
  });

  const markUsed = () => markDaemonUsed(appName);

  /**
   * Bring the daemon up if the idle reaper (or the user) stopped it, and mark
   * it used either way. A no-op when already online — the overwhelmingly
   * common case, and it has to stay cheap enough to sit in front of every
   * request: the one PM2 status read it costs is the same read a status poll
   * already does.
   *
   * Resolves `{ ready, reason }` rather than throwing: a caller in front of an
   * inference request wants to report "could not be started" alongside its own
   * error, not have a lazy start unwind its stack.
   *
   * Single-flight: concurrent callers (two CoS agents, an agent plus a voice
   * turn) share one wake. Without it each saw the daemon offline and called
   * `start`, whose `pm2 delete` killed the sibling launch, so both failed with
   * "exited while loading". Joining is safe because the launch line comes from
   * live/saved state, not from the caller. The slot clears on settle, so a later
   * wake after another stop starts the daemon again.
   *
   * The slot is exclusive and shared with `runStart` (#12723): an explicit start
   * or a tuning relaunch would otherwise `pm2 delete` an in-flight wake's
   * process, the same race between a different pair of callers. A wake that
   * arrives during one waits for it, then finds the daemon online.
   */
  const starts = createSingleFlight({ exclusive: true });

  const trackStart = async (key, fn) => {
    inFlightStarts += 1;
    markUsed();
    try {
      return await starts.run(key, fn);
    } finally {
      inFlightStarts = Math.max(0, inFlightStarts - 1);
      markUsed();
    }
  };

  const ensureRunning = () => trackStart('wake', wake);

  const armLoadWatch = (endpoint) => {
    inFlightLoads += 1;
    const settle = () => {
      inFlightLoads = Math.max(0, inFlightLoads - 1);
      markUsed();
    };
    // Two-arm then, not finally: a floating finally re-raises on a promise
    // nobody awaits. The watch must not hold the caller's start open — launch*
    // returns after its short budget while a cold checkpoint is still loading.
    waitForReady(endpoint).then(settle, settle);
  };

  /**
   * Run an explicit start/stop sequence (a user-clicked Start, a tuning
   * relaunch) in the daemon's exclusive start slot. Each call gets its own key,
   * so it queues behind an in-flight wake or start rather than joining it: its
   * launch config can differ from the one being loaded. `fn` must call the
   * manager's raw start, never `ensureRunning` or `runStart` — either would
   * wait on the slot `fn` itself holds.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const runStart = (fn) => trackStart(Symbol('start'), async () => {
    const result = await fn();
    if (result?.online === false && typeof result.endpoint === 'string') armLoadWatch(result.endpoint);
    return result;
  });

  const wake = async () => {
    const pm2Status = await getStatusStrict();
    if (pm2Status?.status === 'online') {
      // Reuse the status just read. A second PM2 read here would sit on every
      // request, and getConfig() is still null until argv is recovered.
      if (!portEndpoint(getConfig())) await refreshBoundEndpoint(pm2Status);
      return { ready: true, reason: null };
    }

    // Resolve the launch line BEFORE probing, so the probe below asks about
    // the port this start would actually bind. `resolveLaunch` sets the
    // precedence: the config recovered from the last live process, then the
    // launch the user saved, then the daemon's own default.
    const saved = await savedLaunchConfig();
    const config = resolveLaunch(getConfig(), saved);
    if (Number.isFinite(Number(config?.port))) boundEndpoint = endpointFor({ port: Number(config.port) });

    // Something else is already serving that port — a daemon the user started
    // outside PortOS, or another process entirely. Either way this is not
    // ours to start, and probing beats racing `start` into a port conflict.
    const endpoint = endpointFor(config);
    if (await probe(endpoint)) return { ready: true, reason: null };

    console.log(`${emoji} ${label} is stopped — starting it for an incoming request`);
    const started = await start(config).catch((err) => ({ error: err }));

    if (started.error) return { ready: false, reason: started.error.message };
    // `start` returns as soon as it knows the process did not die on the
    // spot; a multi-gigabyte checkpoint routinely outlasts that window, so the
    // caller's request has to wait for the real readiness signal.
    if (started.online) return { ready: true, reason: null };
    return waitForReady(started.endpoint ?? endpoint);
  };

  /** Is `provider` served by the port THIS daemon's live launch is bound to? */
  const servesPort = (provider, managedPort) =>
    Boolean(managedPort) && Number(localEndpointPort(provider?.endpoint)) === managedPort;

  return {
    ensureRunning,
    runStart,
    markUsed,
    registerIdle,
    waitForReady,
    servesPort,
    // Card-status reads. Kept on the returned object rather than re-declared
    // in the manager — that is exactly the "no longer define
    // configuredIdleMinutes/configuredKeepLoaded" half of #8105.
    idleMinutes: configuredIdleMinutes,
    keepLoaded: configuredKeepLoaded,
    savedLaunch: savedLaunchConfig,
    setIdleMinutesOverrideForTests: (value) => { idleMinutesOverride = value; },
    setKeepLoadedOverrideForTests: (value) => { keepLoadedOverride = value; },
  };
}
