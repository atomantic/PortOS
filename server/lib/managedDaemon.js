/**
 * Shared plumbing for a local daemon PortOS runs as an optional PM2 process
 * (`llamaServerManager.js` → `portos-llama-server`, `mtplxServerManager.js` →
 * `portos-mtplx`, `slotstreamServerManager.js` → `portos-slotstream`).
 *
 * Both managers answer the same two questions the same way, and the answers are
 * fiddly enough that two copies drift:
 *
 *   - **What did it print?** A launcher card is useless without the daemon's
 *     recent output, and the output lives in two places — the lines PortOS
 *     itself logged around the launch, and what `pm2 logs` has. They have to be
 *     merged without duplicating the overlap and without growing unbounded.
 *   - **What was it launched with?** After a PortOS restart the only record of a
 *     still-online daemon's configuration is its PM2 argv, so both managers
 *     recover the launch flags by reading values back out of that array.
 *
 * Deliberately NOT a "daemon manager" abstraction: what each daemon's launch
 * line means, when it may be started, and what a refusal should say are exactly
 * the parts that differ, and folding them together would produce a base class
 * with two special cases. This is the shared *mechanism* only.
 */

/**
 * The PM2 process names of the local model servers PortOS manages.
 *
 * Declared here rather than in each manager so the health monitor can recognize
 * them without importing a manager (and its whole PM2/model-probe dependency
 * chain); `llamaServerManager.js`, `mtplxServerManager.js`, and
 * `slotstreamServerManager.js` re-export these as `LLAMA_APP` / `MTPLX_APP` /
 * `SLOTSTREAM_APP`.
 */
export const LLAMA_APP = 'portos-llama-server';
export const MTPLX_APP = 'portos-mtplx';
export const SLOTSTREAM_APP = 'portos-slotstream';
const MODEL_SERVER_APPS = [LLAMA_APP, MTPLX_APP, SLOTSTREAM_APP];

/**
 * Whether a PM2 process is one of those model servers.
 *
 * A model server's resident size IS the checkpoint it loaded — llama.cpp,
 * MTPLX, and Slotstream hold multi-GB weights for as long as they are up, by
 * design. Measuring
 * them against a generic per-process memory cap produces a warning the user can
 * never clear (a 24GB llama-server against a 2GB cap is a correctly-running
 * server, not a leak), so callers policing per-process memory skip them. Genuine
 * host-wide pressure is still reported — `services/proactiveAlerts.js` alerts on
 * total used-vs-installed memory, which is where a too-large model actually
 * shows up.
 *
 * @param {string} [name] PM2 process name
 */
export const isModelServerProcess = (name) => MODEL_SERVER_APPS.includes(name);

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
 * the watcher owns the common PM2 adoption, status skeleton, bounded logs, and
 * stop-then-relaunch port-release wait. State remains in the manager through
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
  getAppStatus,
  getSavedProcessNames,
  execPm2,
  getPortReleaseTimeoutMs,
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

  const getStatusBase = async ({ installed }) => {
    const [pm2Status, savedApps] = await Promise.all([getAppStatus(appName), getSavedProcessNames()]);
    const isReadFailed = pm2Status === null;
    const isManagedActive = pm2Status?.status === 'online';
    const config = recoverConfig(pm2Status);
    const resolvedEndpoint = endpointFor(config);
    const reachable = await probe(resolvedEndpoint);
    const pm2Logs = pm2Status && pm2Status.status !== 'not_found'
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
      recentLogs: logs.withPm2Logs(`${pm2Logs?.stdout || ''}\n${pm2Logs?.stderr || ''}`),
      lastExitError: isReadFailed ? 'Failed to read PM2 status' : getLastExitError(),
    };
  };

  const waitForPortRelease = async (port) => {
    const deadline = Date.now() + getPortReleaseTimeoutMs();
    while (Date.now() < deadline && await isPortInUse(port)) await sleep(200);
  };

  return {
    appendLog: logs.append,
    endpoint,
    getStatusBase,
    readLaunch,
    resetLogs: logs.reset,
    snapshotLogs: logs.snapshot,
    waitForPortRelease,
  };
}

// =============================================================================
// IDLE REAPER
// =============================================================================

/**
 * Shared "stop this daemon when nothing has used it for a while" mechanism.
 *
 * ONLY for a daemon that cannot release its weights any other way. `llama-server`
 * deliberately does NOT register here: it carries its own `--sleep-idle-seconds`,
 * which unloads the model in place and reloads it on the next request without the
 * process ever going away (see `llamaServerManager.js`). Stopping that process to
 * reclaim the same memory would trade a cheap internal reload for a full PM2
 * cold start, and lose the launch line with it. MTPLX has no such flag — its
 * `--retrieval-idle-timeout` unloads retrieval models only, never the main
 * checkpoint — so stopping the process is the only way to get its 20GB back, and
 * it is the one registrant.
 *
 * One `setInterval` for every registrant, not one per daemon: the beat is a
 * coarse poll against a timestamp, so N timers would buy nothing but N chances
 * to leak one.
 */

/** How often the reaper checks. Coarse on purpose — the windows are minutes. */
const IDLE_REAP_INTERVAL_MS = 60_000;

/** name → `{ getIdleMs, stop, lastUsedAt }`. */
const idleDaemons = new Map();
let reaperTimer = null;

/**
 * A user-supplied idle window in minutes, as milliseconds.
 *
 * `0` means "never stop" and is returned as `0`, NOT as null — it is a real
 * choice (today's always-on behaviour) and must survive a round-trip through
 * settings distinguishably from "no value stored". Anything unparseable or
 * negative is `null` = not configured, which the reaper also treats as never.
 *
 * @param {unknown} minutes
 * @returns {number|null}
 */
export function idleWindowMs(minutes) {
  // `Number(null)` and `Number('')` are both 0, which would make "nothing
  // stored" indistinguishable from the user explicitly choosing "never stop".
  // They mean the same thing to the reaper, but not to a caller reporting what
  // is configured — so absent stays null.
  if (minutes === null || minutes === undefined || minutes === '') return null;
  const n = Number(minutes);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n) * 60_000;
}

/**
 * Register a daemon the reaper may stop.
 *
 * `lastUsedAt` is seeded to NOW rather than to null, so a daemon that was just
 * started by hand — or one PortOS re-adopted after its own restart — gets a
 * full idle window before it is eligible. Seeding null and treating it as
 * "infinitely idle" would reap a server the user started seconds ago.
 *
 * Re-registering the same name refreshes the hooks and leaves `lastUsedAt`
 * alone, so a manager reloaded under test doesn't reset a live clock.
 *
 * @param {{name: string, getIdleMs: () => Promise<number|null>|number|null, stop: () => Promise<unknown>}} daemon
 *   `getIdleMs` resolves the CURRENT configured window on every sweep (so a
 *   settings change takes effect without a restart); `null`/`0` = never stop.
 */
export function registerIdleDaemon({ name, getIdleMs, stop }) {
  const existing = idleDaemons.get(name);
  idleDaemons.set(name, {
    getIdleMs,
    stop,
    lastUsedAt: existing?.lastUsedAt ?? Date.now(),
  });
}

/**
 * Record that something just used `name` — the signal the whole mechanism runs
 * on. Call it on real traffic (an inference request, a lazy start), never on a
 * status poll: a status card that refreshes every few seconds would otherwise
 * hold a 24GB checkpoint resident forever while nobody used it.
 *
 * A no-op for an unregistered name, so a call site doesn't have to know whether
 * this install registered that daemon.
 *
 * @param {string} name
 */
export function markDaemonUsed(name) {
  const entry = idleDaemons.get(name);
  if (entry) entry.lastUsedAt = Date.now();
}

/** The recorded last-use timestamp for `name`, or `null`. Exposed for status cards. */
export function daemonLastUsedAt(name) {
  return idleDaemons.get(name)?.lastUsedAt ?? null;
}

/**
 * One sweep: stop every registered daemon whose window has elapsed.
 *
 * Exported so a test can drive it directly instead of waiting on the timer, and
 * so a caller can force a sweep after a settings change.
 *
 * @param {number} [now]
 * @returns {Promise<string[]>} the names actually stopped
 */
export async function reapIdleDaemons(now = Date.now()) {
  const stopped = [];
  for (const [name, entry] of idleDaemons) {
    // Resolved per sweep, so lowering the window in Settings applies to the very
    // next beat rather than to the next server restart.
    const windowMs = await Promise.resolve(entry.getIdleMs()).catch(() => null);
    if (!windowMs || windowMs <= 0) continue;
    if (now - entry.lastUsedAt < windowMs) continue;

    const idleMin = Math.round((now - entry.lastUsedAt) / 60_000);
    console.log(`💤 Stopping ${name} — idle ${idleMin}m (window ${Math.round(windowMs / 60_000)}m)`);
    // `stop` reaches PM2 over a subprocess. A failure here must not kill the
    // interval that every other daemon's reaping depends on.
    const failed = await Promise.resolve(entry.stop()).then(() => null, (err) => err);
    if (failed) {
      console.error(`❌ Idle stop of ${name} failed: ${failed.message}`);
      continue;
    }
    // Only on success: a failed stop that left the daemon up would otherwise
    // retry every beat forever with the clock reset each time.
    entry.lastUsedAt = now;
    stopped.push(name);
  }
  return stopped;
}

/**
 * Arm the single reaper timer. Idempotent — a second call is a no-op rather than
 * a second interval.
 *
 * Boot-safe by construction: it arms a timer and reads timestamps. It makes no
 * AI provider call, which is what lets `server/index.js` start it unconditionally
 * under AGENTS.md's "No cold-bootstrap LLM calls" rule.
 *
 * @param {{intervalMs?: number}} [options]
 */
export function startIdleReaper({ intervalMs = IDLE_REAP_INTERVAL_MS } = {}) {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    // Outside the Express request lifecycle: an unhandled rejection here would
    // take the process down, so the sweep's own failures are swallowed after
    // logging (each daemon's stop failure is already reported individually).
    reapIdleDaemons().catch((err) => console.error(`❌ Idle reaper sweep failed: ${err.message}`));
  }, intervalMs);
  // Never hold the event loop open for this — a shutdown must not wait a minute
  // for a poll that has nothing to do.
  reaperTimer.unref?.();
  console.log(`💤 Idle reaper armed (checking every ${Math.round(intervalMs / 1000)}s)`);
}

/** Disarm the reaper. For shutdown and for test isolation. */
export function stopIdleReaper() {
  if (!reaperTimer) return;
  clearInterval(reaperTimer);
  reaperTimer = null;
}

/** Test seam: drop every registration and disarm the timer. */
export function _resetIdleDaemonsForTests() {
  stopIdleReaper();
  idleDaemons.clear();
}
