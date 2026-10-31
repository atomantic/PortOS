import { spawn } from '../lib/childProcess.js';
import { existsSync } from 'fs';
import { writeFile, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { atomicWrite, safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { parseCommandArgs } from '../lib/commandSecurity.js';
import { parsePm2JlistStdout } from '../lib/pm2Jlist.js';
import { beginLoadSample, formatLoadAttribution, roundMs } from '../lib/eventLoopLagProbe.js';
import { PATHS } from '../lib/paths.js';
import { serverSecretEnvKeys, withoutServerSecretsEnv } from '../lib/processEnv.js';
// The leaf, not readinessNotify.js: its observer's lazy imports would join
// pm2.js's ~280 suites to the CoS cluster's CI selection (#12285).
import { noteReadinessChanged } from './readinessSignal.js';

const IS_WIN = process.platform === 'win32';

// TTL cache for jlist results to reduce CLI churn during rapid UI refreshes
const JLIST_TTL_MS = 400;
const JLIST_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 1_000;
const jlistCache = new Map();
const jlistInflight = new Map();
const cacheKey = (pm2Home) => pm2Home || '_default';

// Track PM2 read failures per home so we log only on state change or reason change
const jlistFailureState = new Map(); // home -> { lastError: string }

/**
 * Invalidate the jlist TTL cache (e.g. after mutations like start/stop/delete).
 * @param {string|null} [pm2Home=null]
 */
export function clearJlistCache(pm2Home = null) {
  noteReadinessChanged('health');
  noteReadinessChanged('capabilities');
  if (pm2Home !== undefined && pm2Home !== null) {
    jlistCache.delete(cacheKey(pm2Home));
  } else {
    jlistCache.clear();
  }
}

/**
 * Record a PM2 read failure and log it only on state change or reason change.
 * @param {string|null} pm2Home The PM2 home being read
 * @param {string} errorReason Formatted error description
 * @param {string} [attribution] Numbers appended to the line, never part of the dedupe key
 * @private
 */
function logJlistFailure(pm2Home, errorReason, attribution = '') {
  const key = cacheKey(pm2Home);
  const state = jlistFailureState.get(key);
  const homeDesc = pm2Home ? 'custom' : 'default';

  // Log only if no prior state, or if the reason changed
  if (!state || state.lastError !== errorReason) {
    console.error(`❌ PM2 read failed (home=${homeDesc}): ${errorReason}${attribution}`);
    jlistFailureState.set(key, { lastError: errorReason });
  }
}

/**
 * Record recovery from a PM2 read failure.
 * @param {string|null} pm2Home The PM2 home that recovered
 * @private
 */
function logJlistRecovery(pm2Home) {
  const key = cacheKey(pm2Home);
  const state = jlistFailureState.get(key);

  if (state) {
    const homeDesc = pm2Home ? 'custom' : 'default';
    console.log(`✅ PM2 read recovered (home=${homeDesc})`);
    jlistFailureState.delete(key);
  }
}

// Resolve PM2 CLI binary path from our local dependency using require.resolve
// to handle hoisted node_modules correctly.
const require = createRequire(import.meta.url);
const ECOSYSTEM_FILE = 'ecosystem.config.cjs';
const LEGACY_ECOSYSTEM_FILE = 'ecosystem.config.js';
const PM2_BIN = join(dirname(require.resolve('pm2/package.json')), 'bin', 'pm2');

/**
 * Check if a script path is a JS file that PM2 can fork through Node.
 * Other executable commands (including shell scripts) must run directly so PM2
 * does not try to parse them as JavaScript.
 */
function isJsScript(script) {
  return /\.(?:js|mjs|cjs|ts)$/i.test(script);
}

/**
 * PM2 exports a managed process's own `pm2_env` into that process's environment
 * as lowercase config keys, and the PM2 CLI reads those keys back as config —
 * where they outrank an explicit CLI flag. Since PortOS itself runs under PM2,
 * every `pm2 start` it spawns would otherwise inherit *portos-server's* config.
 *
 * That is how a loaded, serving llama-server kept dying: it was handed
 * portos-server's 4GB `max_memory_restart`, so PM2's memory watchdog (which
 * fires regardless of `--no-autorestart`) killed the 25GB model process seconds
 * after every successful load, forever. `exec_mode` and `watch` leak the same
 * way — verified by starting a process with each key set in the environment.
 *
 * `node_args` joins them for the same reason: portos-server carries its own V8
 * heap cap (ecosystem.config.cjs), and leaking that into a `pm2 start` would cap
 * every app PortOS launches at portos-server's ceiling — including an app whose
 * whole job is to hold more than that.
 */
const INHERITED_PM2_CONFIG_KEYS = ['max_memory_restart', 'exec_mode', 'watch', 'node_args'];

/** Drop the PM2 config keys PM2 injected into our own environment. */
function withoutInheritedPm2Config(env) {
  const clean = { ...env };
  for (const key of INHERITED_PM2_CONFIG_KEYS) delete clean[key];
  return clean;
}

/**
 * Spawn PM2 CLI via local binary (node pm2/bin/pm2).
 * Always uses the local PM2 binary to avoid depending on a global pm2 install.
 * On Windows this also skips the pm2.cmd shim, dropping the cmd.exe -> pm2.cmd
 * -> node hops and the PATH-resolution ambiguity that comes with them.
 *
 * A default 'error' listener is attached so that an ENOENT or EACCES error
 * (e.g. missing Node binary) doesn't crash Node via the uncaught-EventEmitter
 * exception path when no caller attaches its own 'error' listener.
 * Callers that attach their own 'error' handler are unaffected — multiple
 * listeners are fine and all receive the event.
 *
 * @param {string[]} pm2Args PM2 CLI arguments (e.g. ['jlist'], ['start', 'ecosystem.config.cjs'])
 * @param {object} opts Spawn options (cwd, env, etc.)
 * @returns {ChildProcess}
 */
export function spawnPm2(pm2Args, opts = {}) {
  // windowsHide comes from lib/childProcess.js. Re-asserting it here would also
  // outrank a caller's explicit opt-out, which the wrapper deliberately honors.
  // The env sanitize applies to a caller-supplied env too — it inherits
  // `process.env`, so it carries the same injected keys.
  const child = spawn(process.execPath, [PM2_BIN, ...pm2Args], {
    ...opts,
    env: withoutInheritedPm2Config(opts.env || process.env),
  });
  // Default error handler — prevents an uncaught EventEmitter 'error' crash
  // when no caller attaches its own handler. Callers that do attach their own
  // 'error' listener receive the event too (multiple listeners are additive).
  child.on('error', (err) => {
    console.error(`❌ spawnPm2 error [${pm2Args[0]}]: ${err.message}`);
  });
  return child;
}

/**
 * Execute a PM2 CLI command and return stdout/stderr as a promise.
 * Drop-in replacement for execAsync('pm2 ...') that bypasses pm2.cmd on Windows.
 *
 * TESTING — `vi.spyOn(pm2Module, 'execPm2')` is NOT enough on its own. It
 * intercepts callers in OTHER modules (mtplxServerManager, llamaServerManager),
 * but every export in THIS file that calls `execPm2`/`spawnPm2` reads the local
 * binding and runs the real implementation regardless of the spy — silently, with
 * the test still passing. `pm2.savedProcesses.test.js` relied on that and really
 * ran `pm2 save`, and PM2 forked a God Daemon per test that outlived the suite:
 * 641 orphans holding 38 GB accumulated on one dev machine before anyone noticed.
 * A test that calls into this module must mock the spawn seam instead —
 * `vi.mock('../lib/childProcess.js', … spawn: mockSpawn)`, as pm2.launch.test.js
 * and pm2.savedProcesses.test.js do — and assert the mock was reached.
 *
 * @param {string[]} pm2Args PM2 CLI arguments (e.g. ['jlist'])
 * @param {object} opts Spawn options (env, cwd, etc.) plus timeoutMs (default 60s)
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export function execPm2(pm2Args, { timeoutMs = COMMAND_TIMEOUT_MS, ...opts } = {}) {
  return runPm2Command(pm2Args, opts, timeoutMs);
}

function runPm2Command(pm2Args, opts, timeoutMs, allowNonzeroWithoutStderr = false) {
  return new Promise((resolve, reject) => {
    const child = spawnPm2(pm2Args, opts);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let cleanupTimer;
    const onStdout = data => { stdout += data.toString(); };
    const onStderr = data => { stderr += data.toString(); };
    const finish = (error, cleanupConfirmed = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      if (timedOut) {
        // Killing the CLI cannot undo a mutation already accepted by the daemon.
        error = Object.assign(new Error(`pm2 ${pm2Args.join(' ')} timed out after ${timeoutMs / 1000}s; CLI cleanup ${cleanupConfirmed ? 'confirmed' : 'unconfirmed'}, daemon outcome unknown`), {
          code: 'PM2_TIMEOUT', timedOut: true, cleanupConfirmed, outcome: 'unknown',
        });
        if (!cleanupConfirmed) {
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref?.();
        }
      }
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    const onClose = code => finish(code === 0 || (allowNonzeroWithoutStderr && !stderr)
      ? null : new Error(stderr || `pm2 exited with code ${code}`));
    // An error after spawn (e.g. a failed kill) does not prove the child exited.
    const onError = error => { if (!timedOut) finish(error); };
    const signal = value => {
      try { child.kill(value); }
      catch (error) { console.error(`❌ PM2 CLI ${value} failed: ${error.message}`); }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      cleanupTimer = setTimeout(() => {
        cleanupTimer = setTimeout(() => finish(null, false), KILL_GRACE_MS);
        signal('SIGKILL');
      }, KILL_GRACE_MS);
      // The direct child is Node running PM2, never a shell or managed app.
      signal('SIGTERM');
    }, timeoutMs);
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('close', onClose);
    child.on('error', onError);
  });
}

/**
 * Build environment object with optional custom PM2_HOME.
 *
 * Exported because the log-stream socket handler spawns `pm2 logs` directly
 * (not through spawnPm2Cli) and must target the same home the app's processes
 * live in — otherwise an app with its own PM2 instance streams an empty log.
 *
 * @param {string} pm2Home Optional custom PM2_HOME path
 * @returns {object} Environment variables
 */
export function buildEnv(pm2Home) {
  const env = { ...process.env };
  if (pm2Home) {
    env.PM2_HOME = pm2Home;
  }
  // Strip PortOS env vars to avoid conflicts
  delete env.PORT;
  delete env.HOST;
  return env;
}

// Env for a CLI `pm2 start` of a managed app: buildEnv() minus server secrets.
function buildStartEnv(pm2Home) {
  return withoutServerSecretsEnv(buildEnv(pm2Home));
}

// The Node API merges process.env into the child; its `filter_env` option (an
// array of names) is the only way to drop inherited keys. Explicit `env`
// entries are applied after the filter, so configured variables still arrive.
const serverSecretFilterEnv = () => serverSecretEnvKeys(process.env);

/**
 * Spawn a PM2 CLI command with optional custom PM2_HOME
 * @param {string} action PM2 action (stop, restart, delete)
 * @param {string} name PM2 process name
 * @param {string} pm2Home Optional custom PM2_HOME path
 * @returns {Promise<{success: boolean}>}
 */
async function spawnPm2Cli(action, name, pm2Home) {
  await execPm2([action, name], { env: buildEnv(pm2Home) });
  clearJlistCache(pm2Home);
  return { success: true };
}

/** Each operation owns its native client, including deadline teardown. */
async function connectAndRun(action, timeoutMs = COMMAND_TIMEOUT_MS, { existingOnly = false } = {}) {
  // Importing PM2 constructs its singleton and probes the interactor socket.
  // Merely loading a reconciliation/peer-sync dependency must not contact it.
  const { default: pm2 } = await import('pm2');
  return new Promise((resolve, reject) => {
    const client = new pm2.custom();
    let settled = false;
    const disconnect = () => new Promise(resolveCleanup => {
      // launchRPC can be left reconnecting to a vanished daemon. Close that
      // socket directly: PM2's disconnectRPC rejects without closing it while
      // disconnected, which would leak a retrying handle after our deadline.
      const socket = existingOnly ? client.Client?.client_sock : null;
      if (socket && socket.connected === false) {
        try { socket.close(); } catch { /* already closed */ }
        resolveCleanup(null);
        return;
      }
      let cleaned = false;
      const done = error => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(cleanupTimer);
        if (!error) { resolveCleanup(null); return; }
        console.error(`❌ PM2 client disconnect failed: ${error.message}`);
        resolveCleanup(Object.assign(new Error('PM2 client cleanup unconfirmed'), {
          cause: error, code: 'PM2_CLEANUP_UNKNOWN', cleanupConfirmed: false, outcome: 'unknown',
        }));
      };
      const cleanupTimer = setTimeout(() => done(new Error('disconnect timed out')), KILL_GRACE_MS);
      try { client.disconnect(done); }
      catch (error) { done(error); }
    });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void disconnect().then(cleanupError => {
        if (cleanupError) error = Object.assign(error || cleanupError, { cleanupConfirmed: false });
        if (error) reject(error);
        else resolve(result);
      });
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('pm2 RPC timed out; client disconnect requested, daemon outcome unknown'), {
      code: 'PM2_TIMEOUT', timedOut: true, cleanupConfirmed: false, outcome: 'unknown',
    })), timeoutMs);
    const onConnect = error => {
      // Connect can finish after its deadline and open new socket handles.
      if (settled) { void disconnect(); return; }
      if (error) { finish(error); return; }
      Promise.resolve().then(() => {
        if (settled) return;
        return action(client);
      }).then(result => finish(null, result), finish);
    };
    // PM2's connect() starts a daemon when none is reachable. Status reads
    // used by background checks must never have that side effect.
    try { if (existingOnly) client.Client.launchRPC(onConnect); else client.connect(onConnect); }
    catch (error) { finish(error); }
  });
}

/**
 * Start an app with PM2
 * @param {string} name PM2 process name
 * @param {object} options Start options
 */
export async function startApp(name, options = {}) {
  return connectAndRun((pm2) => {
    return new Promise((resolve, reject) => {
      const script = options.script || 'npm';
      const startOptions = {
        name,
        script,
        args: options.args || 'run dev',
        cwd: options.cwd,
        env: options.env || {},
        filter_env: serverSecretFilterEnv(),
        watch: false,
        autorestart: true,
        max_restarts: 10,
        min_uptime: '10s',
        restart_delay: 5000,
        windowsHide: IS_WIN
      };

      // Non-JS commands must run directly: PM2 otherwise forks them through
      // Node, which parses shell scripts as JavaScript on every platform.
      if (!isJsScript(script)) {
        startOptions.interpreter = 'none';
      }

      pm2.start(startOptions, (err, proc) => {
        if (err) return reject(err);
        clearJlistCache();
        resolve({ success: true, process: proc });
      });
    });
  });
}

/**
 * Stop an app
 * @param {string} name PM2 process name
 * @param {string} pm2Home Optional custom PM2_HOME path
 */
export async function stopApp(name, pm2Home = null) {
  // Use CLI for custom PM2_HOME
  if (pm2Home) {
    return spawnPm2Cli('stop', name, pm2Home);
  }

  return connectAndRun((pm2) => {
    return new Promise((resolve, reject) => {
      pm2.stop(name, (err) => {
        if (err) return reject(err);
        clearJlistCache();
        resolve({ success: true });
      });
    });
  });
}

/**
 * Restart an app
 * @param {string} name PM2 process name
 * @param {string} pm2Home Optional custom PM2_HOME path
 */
export async function restartApp(name, pm2Home = null) {
  return spawnPm2Cli('restart', name, pm2Home);
}

/**
 * Delete an app from PM2
 * @param {string} name PM2 process name
 * @param {string} pm2Home Optional custom PM2_HOME path
 */
export async function deleteApp(name, pm2Home = null) {
  // Use CLI for custom PM2_HOME
  if (pm2Home) {
    return spawnPm2Cli('delete', name, pm2Home);
  }

  return connectAndRun((pm2) => {
    return new Promise((resolve, reject) => {
      pm2.delete(name, (err) => {
        if (err) return reject(err);
        clearJlistCache();
        resolve({ success: true });
      });
    });
  });
}

/**
 * Get status of a specific process using CLI (avoids connection deadlocks)
 * @param {string} name PM2 process name
 * @param {string} pm2Home Optional custom PM2_HOME path
 */
export async function getAppStatus(name, pm2Home = null) {
  const processes = await fetchJlist(pm2Home);
  // `error` here means "PM2 read failed", but it's the same forgiving shape the
  // generic callers expect. App-status callers that must distinguish a failed
  // read from a genuine state use getAppStatusStrict (null sentinel) instead.
  if (!processes) return { name, status: 'error', pm2_env: null };
  const proc = processes.find(p => p.name === name);

  if (!proc) {
    return { name, status: 'not_found', pm2_env: null };
  }

  return shapeProcStatus(proc);
}

/**
 * Strict variant of {@link getAppStatus}: returns `null` when the PM2 read
 * FAILED, distinct from a `{ status: 'not_found' }` for a read that succeeded
 * but found no matching process. The detail endpoint uses this so a daemon
 * blip surfaces as `degraded` rather than a confident `not_started`.
 *
 * @returns {Promise<object|null>} Process status, `{ status: 'not_found' }`, or
 *   `null` on read failure.
 */
export async function getAppStatusStrict(name, pm2Home = null) {
  const processes = await fetchJlist(pm2Home);
  if (!processes) return null;
  const proc = processes.find(p => p.name === name);
  if (!proc) return { name, status: 'not_found', pm2_env: null };
  return shapeProcStatus(proc);
}

// Shared shaping for getAppStatus / getAppStatusStrict so the two never drift.
function shapeProcStatus(proc) {
  return {
    name: proc.name,
    status: proc.pm2_env?.status || 'unknown',
    pid: proc.pid,
    pm_id: proc.pm_id,
    cpu: proc.monit?.cpu || 0,
    memory: proc.monit?.memory || 0,
    uptime: proc.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null,
    restarts: proc.pm2_env?.restart_time || 0,
    unstableRestarts: proc.pm2_env?.unstable_restarts || 0,
    createdAt: proc.pm2_env?.created_at || null,
    args: proc.pm2_env?.args || null
  };
}

/**
 * Parse the stdout of a `pm2 jlist` (custom PM2_HOME CLI path) into a raw
 * process array, or `null` when the read effectively failed.
 *
 * Compatibility re-export: the strict parser now lives in the pure
 * `server/lib/pm2Jlist.js` (issue #8164) so package-local consumers like the
 * autofixer can import it without the rest of this service. Kept exported here
 * under its original name for existing first-party callers/tests.
 *
 * @param {string} stdout Raw `pm2 jlist` stdout (may carry ANSI noise).
 * @returns {Array|null} The parsed process array (incl. `[]`), or `null` on failure.
 */
export const parseJlistStdout = parsePm2JlistStdout;

/**
 * Fetch PM2 process list with TTL caching.
 * Uses the PM2 Node.js API for the default PM2_HOME (no subprocess spawning — avoids
 * visible cmd windows on Windows). Falls back to CLI only for custom PM2_HOME paths.
 * @param {string} pm2Home Optional custom PM2_HOME path
 * @returns {Promise<Array|null>} Raw process list from PM2, or null on error
 */
function fetchJlist(pm2Home = null) {
  const key = cacheKey(pm2Home);
  const cached = jlistCache.get(key);
  if (cached && Date.now() - cached.ts < JLIST_TTL_MS) return Promise.resolve(cached.data);

  const inflight = jlistInflight.get(key);
  if (inflight) return inflight;

  // A timed-out read is the usual first symptom of a stalled loop, so it carries
  // its own busy-versus-starved attribution (#12852).
  const startedAt = performance.now();
  const sample = beginLoadSample();
  // Defer the read until the single-flight entry exists, even for a sync callback.
  const promise = Promise.resolve().then(() => pm2Home
    ? execPm2(['jlist'], { env: buildEnv(pm2Home), timeoutMs: JLIST_TIMEOUT_MS })
      .then(({ stdout }) => parseJlistStdout(stdout))
    : connectAndRun(client => new Promise((resolve, reject) => {
      client.list((error, list) => error ? reject(error) : resolve(list));
    }), JLIST_TIMEOUT_MS)
  ).then(list => {
    if (!Array.isArray(list)) throw new Error('Invalid PM2 process list response');
    logJlistRecovery(pm2Home);
    jlistCache.set(key, { data: list, ts: Date.now() });
    return list;
  }).catch(error => {
    const attribution = error?.timedOut
      ? ` wallMs=${roundMs(performance.now() - startedAt)}${formatLoadAttribution(sample.read())}`
      : '';
    logJlistFailure(pm2Home, error.message || String(error), attribution);
    return null;
  }).finally(() => {
    sample.end();
    if (jlistInflight.get(key) === promise) jlistInflight.delete(key);
  });

  jlistInflight.set(key, promise);
  return promise;
}

/**
 * List all PM2 processes
 * @param {string} pm2Home Optional custom PM2_HOME path
 */
export async function listProcesses(pm2Home = null) {
  const list = await fetchJlist(pm2Home);
  if (!list) return [];
  return list.map(mapProcess);
}

/**
 * Strict variant of {@link listProcesses}: returns `null` when the PM2 read
 * FAILED (daemon unreachable / non-zero exit) and the mapped array otherwise —
 * including `[]` for a successful read with no processes.
 *
 * `listProcesses()` flattens a failed read into `[]`, which is the right
 * forgiving behavior for log/command/voice callers that just want "whatever is
 * running." But app-status getters MUST distinguish "PM2 unreachable" from
 * "nothing running" (AGENTS.md absent-vs-empty rule) — collapsing them records
 * a transient blip as every app `not_started`. Those callers use this instead.
 *
 * @param {string} pm2Home Optional custom PM2_HOME path
 * @returns {Promise<Array|null>} Mapped process list, or `null` on read failure.
 */
export async function listProcessesStrict(pm2Home = null) {
  const list = await fetchJlist(pm2Home);
  if (!list) return null;
  return list.map(mapProcess);
}

/**
 * The running daemon's own pm2 and Node versions — what the Node runtime panel
 * compares against the pm2 PortOS ships. Only those two fields leave this
 * function: the daemon's report also carries its whole environment.
 * @returns {Promise<{pm2Version: string|null, nodeVersion: string|null}|null>} null when unreachable
 */
export async function getDaemonIdentity() {
  const rpcPath = process.env.PM2_DAEMON_RPC_PORT || join(process.env.PM2_HOME || join(homedir(), '.pm2'), 'rpc.sock');
  if (!IS_WIN && !existsSync(rpcPath)) return null;
  const report = await connectAndRun(client => new Promise((resolve, reject) => {
    // executeRemote() silently calls start() if its connection has disappeared;
    // use the established RPC directly so a read cannot launch a daemon.
    const rpc = client.Client.client;
    if (!rpc?.call) { reject(new Error('PM2 daemon connection unavailable')); return; }
    rpc.call('getReport', {}, (error, value) => error ? reject(error) : resolve(value));
  }), JLIST_TIMEOUT_MS, { existingOnly: true }).catch(() => null);
  if (!report) return null;
  const text = (value) => (typeof value === 'string' && value && value !== 'N/A' ? value : null);
  return { pm2Version: text(report.pm2_version), nodeVersion: text(report.node_version) };
}

/** Internal maintenance inventory: fresh daemon read, no UI cache or env dump. */
export async function listMaintenanceProcesses() {
  return connectAndRun(pm2 => new Promise((resolve, reject) => {
    pm2.list((err, list) => {
      if (err || !Array.isArray(list)) {
        reject(new Error('PM2 maintenance inventory unavailable.'));
        return;
      }
      resolve(list.map(proc => ({
        name: proc?.name, pmId: proc?.pm_id, pid: proc?.pid,
        status: proc?.pm2_env?.status,
        cwd: proc?.pm2_env?.pm_cwd, script: proc?.pm2_env?.pm_exec_path,
      })));
    });
  }));
}

/**
 * Internal maintenance restart of one PortOS producer. Re-evaluates the
 * install's ecosystem file with --update-env so the app receives the saved
 * database configuration a cutover just committed, never PM2's cached env.
 * `env` is the environment the ecosystem file is evaluated in.
 * PM2 success is not proof of the backend: the restarted process must still
 * prove its own pool (services/databaseCutoverHandshake.js).
 */
export async function restartMaintenanceProducer(name, env = process.env) {
  if (!['portos-server', 'portos-cos'].includes(name)) throw new Error('Unknown maintenance producer.');
  await execPm2(['restart', join(PATHS.installRoot, 'ecosystem.config.cjs'), '--only', name, '--update-env'],
    { cwd: PATHS.installRoot, env });
  return { success: true };
}

// Shared shaping for listProcesses / listProcessesStrict so the two never drift.
function mapProcess(proc) {
  return {
    name: proc.name,
    status: proc.pm2_env?.status || 'unknown',
    pid: proc.pid,
    pm_id: proc.pm_id,
    cpu: proc.monit?.cpu || 0,
    memory: proc.monit?.memory || 0,
    uptime: proc.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null,
    restarts: proc.pm2_env?.restart_time || 0,
    unstableRestarts: proc.pm2_env?.unstable_restarts || 0
  };
}

/**
 * Get logs for a process using pm2 CLI (more reliable for log retrieval)
 * @param {string} name PM2 process name
 * @param {number} lines Number of lines to retrieve
 * @param {string} pm2Home Optional custom PM2_HOME path
 */
export async function getLogs(name, lines = 100, pm2Home = null) {
  const args = ['logs', name, '--lines', String(lines), '--nostream', '--raw'];
  // Preserve the logs reader's historical partial-output contract on nonzero exit.
  const { stdout } = await runPm2Command(args, { env: buildEnv(pm2Home) }, JLIST_TIMEOUT_MS, true);
  return stdout;
}

/**
 * Start an app using a specific command in cwd
 * @param {string} name PM2 process name
 * @param {string} cwd Working directory
 * @param {string} command Command to run (e.g., "npm run dev")
 * @param {object} [options]
 * @param {boolean} [options.autorestart=true] When false, PM2 will NOT relaunch
 *   the process after it exits. Portless/desktop apps (a game window) pass false:
 *   the user closing the window is a normal exit, not a crash to loop on. The
 *   restart-tuning fields (max_restarts/min_uptime/restart_delay) are omitted in
 *   that mode since they only apply when autorestart is on.
 * @param {number} [options.maxRestarts=10] Restart cap when autorestart is on.
 * @param {string} [options.pm2Home=null] Custom PM2_HOME. When set, starts via
 *   CLI (like deleteApp/getAppStatus) instead of the default-daemon Node API —
 *   otherwise the process would launch under PortOS's own PM2 daemon and be
 *   invisible to every subsequent status/log/delete call that targets pm2Home.
 * @param {number} [options.port=null] The app's own port, pinned as PORT in the
 *   child's environment so PortOS's inherited PORT cannot reach it. Pass null
 *   when no single port applies (a portless app, or several processes sharing
 *   one start call) — see the EADDRINUSE note at the env assignment below.
 */
export async function startWithCommand(name, cwd, command, options = {}) {
  const { autorestart = true, maxRestarts = 10, maxMemoryRestart = '500M', pm2Home = null, port = null } = options;
  // Parse with quote-awareness so `node --opt "arg with spaces"` survives;
  // a bare split(' ') would shred quoted segments. PM2 accepts `args` as an
  // array, which avoids re-joining and re-splitting on the way through.
  const [script, ...args] = parseCommandArgs(command);

  if (pm2Home) {
    return spawnPm2StartCommand(name, cwd, script, args, { autorestart, maxRestarts, maxMemoryRestart, pm2Home, port });
  }

  return connectAndRun((pm2) => {
    return new Promise((resolve, reject) => {
      const opts = {
        name,
        script,
        args,
        cwd,
        watch: false,
        autorestart,
        // Restart tuning only matters when autorestart is on; a desktop process
        // exiting cleanly should stay stopped, not be nursed back up. This
        // includes max_memory_restart: PM2's memory monitor relaunches the
        // process independently of autorestart, so leaving a 500M cap on a
        // desktop app (a game window routinely exceeds it) would kill and
        // respawn the live window — exactly the relaunch loop this avoids.
        ...(autorestart
          ? { max_restarts: maxRestarts, min_uptime: '10s', restart_delay: 5000, max_memory_restart: maxMemoryRestart }
          : {}),
        // PM2 snapshots the launching process's environment into the child, so
        // PortOS's own PORT would otherwise reach a managed app and win: both
        // Bun's `--env-file` and dotenv yield to an already-set variable, so the
        // app's env file cannot rescue it. The app then binds PortOS's port and
        // whichever process loses the boot race crashloops on EADDRINUSE.
        // buildEnv() strips PORT/HOST on the CLI path below; the Node API has no
        // way to *unset* an inherited key (it merges `env` over process.env), so
        // pin the app's own recorded port instead. Last writer wins, so this
        // also overrides the app's env file — they agree by construction, since
        // PortOS generates that file from the same port it records.
        ...(port ? { env: { PORT: String(port) } } : {}),
        filter_env: serverSecretFilterEnv(),
        windowsHide: IS_WIN
      };

      // PM2 defaults to Node for command scripts. Run executables directly so
      // native launchers such as `./scripts/game` honor their shebang.
      if (!isJsScript(script)) {
        opts.interpreter = 'none';
      }

      pm2.start(opts, (err, proc) => {
        if (err) return reject(err);
        clearJlistCache();
        resolve({ success: true, process: proc });
      });
    });
  });
}

/**
 * CLI-based counterpart to startWithCommand's Node-API path, used whenever a
 * custom pm2Home is given. `min_uptime` has no CLI flag equivalent — it only
 * tunes the autorestart=true nursing behavior, which no current caller uses
 * together with a custom pm2Home.
 */
async function spawnPm2StartCommand(name, cwd, script, args, { autorestart, maxRestarts, maxMemoryRestart, pm2Home, port = null }) {
  const cliArgs = ['start', script, '--name', name, '--cwd', cwd];
  if (!isJsScript(script)) cliArgs.push('--interpreter', 'none');
  if (autorestart) {
    cliArgs.push('--max-restarts', String(maxRestarts), '--restart-delay', '5000', '--max-memory-restart', String(maxMemoryRestart));
  } else {
    cliArgs.push('--no-autorestart');
  }
  if (args.length > 0) cliArgs.push('--', ...args);
  const env = buildStartEnv(pm2Home);
  if (port) env.PORT = String(port);
  await execPm2(cliArgs, { env });
  clearJlistCache(pm2Home);
  return { success: true };
}

/**
 * Spawn pm2 start with an ecosystem config file
 * @param {string} cwd Working directory
 * @param {string} ecosystemFile Config filename
 * @param {string[]} processNames Processes to start (--only flag)
 * @param {string} pm2Home Optional custom PM2_HOME
 */
async function spawnPm2StartEcosystem(cwd, ecosystemFile, processNames, pm2Home) {
  const args = ['start', ecosystemFile];
  if (processNames.length > 0) args.push('--only', processNames.join(','));
  const { stdout } = await execPm2(args, { cwd, env: buildStartEnv(pm2Home) });
  clearJlistCache(pm2Home);
  return { success: true, output: stdout };
}

/**
 * Persist the CURRENT PM2 process list to PM2's dump file (`pm2 save`).
 *
 * This is the half of "start at boot" PortOS can own. `pm2 startup` writes a
 * system init/launchd unit and is deliberately blocked (see
 * `PM2_BLOCKED_SUBCOMMANDS` in `lib/commandSecurity.js`) — it is a one-time,
 * privileged, machine-level decision the operator makes in a terminal. `pm2
 * save` only rewrites `$PM2_HOME/dump.pm2`, which that unit resurrects, so once
 * the operator has run `pm2 startup` once, saving here is what makes a
 * newly-started daemon (llama-server, MTPLX) come back after a reboot.
 *
 * The dump is process-list wide by design: it snapshots everything currently
 * running, which is exactly what a resurrect needs.
 *
 * @param {string|null} [pm2Home=null]
 */
export async function saveProcessList(pm2Home = null, { exclude = [] } = {}) {
  await execPm2(['save'], { env: buildEnv(pm2Home) });
  const dropped = await dropFromSavedList(exclude, pm2Home);
  return { success: true, excluded: dropped };
}

/**
 * Remove app entries from PM2's dump AFTER `pm2 save` wrote it.
 *
 * `pm2 save` is process-list wide with no exclusion flag — it snapshots whatever
 * is running. That is the wrong answer for a daemon PortOS starts on demand:
 * MTPLX is lazily started by the first request that needs it and stopped again
 * when idle, so resurrecting it at boot would put 20GB back on a machine nobody
 * has asked anything of yet — precisely the waste the idle stop exists to end.
 *
 * Rewriting the dump rather than stopping the daemon first keeps the running
 * process untouched: the user's MTPLX stays up for the session, it just isn't in
 * the list a reboot replays.
 *
 * Best-effort by design. An unreadable or non-JSON dump means PM2 owns a format
 * this doesn't understand, and a save that persisted one extra process is a far
 * better outcome than a corrupted dump that resurrects none.
 *
 * @param {string[]} names app names to drop
 * @param {string|null} [pm2Home]
 * @returns {Promise<string[]>} the names actually removed
 */
async function dropFromSavedList(names, pm2Home = null) {
  if (!names?.length) return [];
  const home = pm2Home || process.env.PM2_HOME || join(homedir(), '.pm2');
  const dumpPath = join(home, 'dump.pm2');
  const raw = await tryReadFile(dumpPath);
  if (raw === null) return [];
  const parsed = safeJSONParse(raw, null, { allowArray: true });
  if (!Array.isArray(parsed)) return [];

  const drop = new Set(names);
  const kept = parsed.filter((app) => !drop.has(app?.name));
  const removed = parsed.length - kept.length;
  if (removed === 0) return [];

  await atomicWrite(dumpPath, kept);
  const dropped = parsed.filter((app) => drop.has(app?.name)).map((app) => app.name);
  console.log(`💾 Excluded ${dropped.join(', ')} from the PM2 boot list (started on demand instead)`);
  return dropped;
}

/**
 * The app names in PM2's saved dump — i.e. what `pm2 resurrect` (and therefore
 * a boot-time `pm2 startup` unit) would bring back.
 *
 * Returns `null` when the dump could not be READ (absent, unreadable, not JSON)
 * — deliberately NOT the same value as `[]` ("read, and it saves nothing"), so a
 * caller can say "unknown" instead of reporting a daemon as not-persisted when
 * PortOS simply could not tell.
 *
 * @param {string|null} [pm2Home=null]
 * @returns {Promise<string[]|null>}
 */
export async function getSavedProcessNames(pm2Home = null) {
  const home = pm2Home || process.env.PM2_HOME || join(homedir(), '.pm2');
  const raw = await tryReadFile(join(home, 'dump.pm2'));
  if (raw === null) return null;
  const parsed = safeJSONParse(raw, null, { allowArray: true });
  if (!Array.isArray(parsed)) return null;
  return parsed.map((app) => app?.name).filter((name) => typeof name === 'string');
}

/**
 * Start app(s) using ecosystem.config.cjs/js file
 * This properly uses all env vars, scripts, args defined in the config
 * @param {string} cwd Working directory containing ecosystem config
 * @param {string[]} processNames Optional: specific processes to start (--only flag)
 * @param {string} pm2Home Optional custom PM2_HOME path
 */
export async function startFromEcosystem(cwd, processNames = [], pm2Home = null) {
  const ecosystemFile = [ECOSYSTEM_FILE, LEGACY_ECOSYSTEM_FILE]
    .find(f => existsSync(`${cwd}/${f}`));

  if (!ecosystemFile) {
    throw new Error('No ecosystem.config.cjs or ecosystem.config.js found');
  }

  // On Windows, PM2 fork mode can't execute .cmd batch files (npm, npx, etc.)
  // Load the config, patch non-JS scripts with interpreter:'none', write temp config
  if (IS_WIN) {
    return startFromEcosystemWindows(cwd, ecosystemFile, processNames, pm2Home);
  }

  return spawnPm2StartEcosystem(cwd, ecosystemFile, processNames, pm2Home);
}

/**
 * Evaluate the app's config inside the sanitized PM2 child, never in the
 * server: a config can copy process.env into an app-specific key before the
 * CLI's inheritance filter runs. Requiring the original file preserves its
 * relative imports and __dirname while this wrapper patches Windows launchers.
 */
async function startFromEcosystemWindows(cwd, ecosystemFile, processNames, pm2Home) {
  const tempFile = `_portos_pm2_${randomUUID()}.config.cjs`;
  const tempPath = join(cwd, tempFile);
  const content = `const config = require(${JSON.stringify(`./${ecosystemFile}`)});
const selected = ${JSON.stringify(processNames)};
for (const app of config.apps || []) {
  if (selected.length && !selected.includes(app.name)) continue;
  if (app.script && !/\\.(?:js|mjs|cjs|ts)$/i.test(app.script) && app.interpreter !== 'none') app.interpreter = 'none';
  if (!app.windowsHide) app.windowsHide = true;
  if (app.autorestart !== false && !app.max_restarts) app.max_restarts = 10;
}
module.exports = config;
`;
  await writeFile(tempPath, content, { flag: 'wx', mode: 0o600 });
  try {
    return await spawnPm2StartEcosystem(cwd, tempFile, processNames, pm2Home);
  } finally {
    // The CLI has closed, so it has finished evaluating this invocation's file.
    await unlink(tempPath).catch(() => {});
  }
}
