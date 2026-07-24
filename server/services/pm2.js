import pm2 from 'pm2';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { writeFile, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { extractJSONArray, safeJSONParse } from '../lib/fileUtils.js';
import { parseCommandArgs } from '../lib/commandSecurity.js';

const IS_WIN = process.platform === 'win32';

// TTL cache for jlist results to reduce CLI churn during rapid UI refreshes
const JLIST_TTL_MS = 400;
const jlistCache = new Map();
const jlistInflight = new Map();
const cacheKey = (pm2Home) => pm2Home || '_default';

// Resolve PM2 CLI binary path from our local dependency using require.resolve
// to handle hoisted node_modules correctly.
const require = createRequire(import.meta.url);
const PM2_BIN = join(dirname(require.resolve('pm2/package.json')), 'bin', 'pm2');

/**
 * Check if a script path is a JS file that PM2 can fork directly.
 * On Windows, non-JS scripts (npm, npx, vite, etc.) resolve to .cmd batch files
 * which PM2's fork mode tries to require() as JavaScript — causing SyntaxError.
 */
function isJsScript(script) {
  return /\.(?:js|mjs|cjs|ts)$/i.test(script);
}

/**
 * Spawn PM2 CLI via local binary (node pm2/bin/pm2).
 * Always uses the local PM2 binary to avoid depending on a global pm2 install.
 * On Windows this also avoids pm2.cmd which creates visible CMD windows.
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
  const child = spawn(process.execPath, [PM2_BIN, ...pm2Args], {
    ...opts,
    windowsHide: true
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
 * @param {string[]} pm2Args PM2 CLI arguments (e.g. ['jlist'])
 * @param {object} opts Spawn options (env, cwd, etc.)
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export function execPm2(pm2Args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnPm2(pm2Args, opts);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `pm2 exited with code ${code}`));
      resolve({ stdout, stderr });
    });
    child.on('error', (err) => reject(err));
  });
}

/**
 * Build environment object with optional custom PM2_HOME
 * @param {string} pm2Home Optional custom PM2_HOME path
 * @returns {object} Environment variables
 */
function buildEnv(pm2Home) {
  const env = { ...process.env };
  if (pm2Home) {
    env.PM2_HOME = pm2Home;
  }
  // Strip PortOS env vars to avoid conflicts
  delete env.PORT;
  delete env.HOST;
  return env;
}

/**
 * Spawn a PM2 CLI command with optional custom PM2_HOME
 * @param {string} action PM2 action (stop, restart, delete)
 * @param {string} name PM2 process name
 * @param {string} pm2Home Optional custom PM2_HOME path
 * @returns {Promise<{success: boolean}>}
 */
function spawnPm2Cli(action, name, pm2Home) {
  return new Promise((resolve, reject) => {
    const child = spawnPm2([action, name], {
      env: buildEnv(pm2Home)
    });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `pm2 ${action} exited with code ${code}`));
      resolve({ success: true });
    });
    child.on('error', reject);
  });
}

/**
 * Connect to PM2 daemon and run an action
 * Note: This uses the default PM2_HOME. For custom PM2_HOME, use CLI commands.
 */
function connectAndRun(action) {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) {
        return reject(err);
      }
      action(pm2)
        .then((result) => {
          pm2.disconnect();
          resolve(result);
        })
        .catch((err) => {
          pm2.disconnect();
          reject(err);
        });
    });
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
        watch: false,
        autorestart: true,
        max_restarts: 10,
        min_uptime: '10s',
        restart_delay: 5000,
        windowsHide: IS_WIN
      };

      // On Windows, non-JS scripts (.cmd batch files) can't be fork'd by PM2
      if (IS_WIN && !isJsScript(script)) {
        startOptions.interpreter = 'none';
      }

      pm2.start(startOptions, (err, proc) => {
        if (err) return reject(err);
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
  // Use CLI for custom PM2_HOME
  if (pm2Home) {
    return spawnPm2Cli('restart', name, pm2Home);
  }

  return connectAndRun((pm2) => {
    return new Promise((resolve, reject) => {
      pm2.restart(name, (err) => {
        if (err) return reject(err);
        resolve({ success: true });
      });
    });
  });
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
    createdAt: proc.pm2_env?.created_at || null
  };
}

/**
 * Parse the stdout of a `pm2 jlist` (custom PM2_HOME CLI path) into a raw
 * process array, or `null` when the read effectively failed.
 *
 * PM2 jlist always emits a JSON array (`[]` when there are no processes), so an
 * exit-0 with empty or garbage stdout (no array literal at all) is a FAILED read
 * — not a successful "no processes." Returning `[]` there would reintroduce the
 * absent-vs-empty footgun (issue #968) for custom PM2_HOME reads. `extractJSONArray`
 * itself falls back to `'[]'` on garbage, so we must detect a real array literal
 * before trusting it (mirroring extractJSONArray's own detection) and return null
 * otherwise — matching the default-home path, which resolves null for a non-array.
 *
 * @param {string} stdout Raw `pm2 jlist` stdout (may carry ANSI noise).
 * @returns {Array|null} The parsed process array (incl. `[]`), or `null` on failure.
 */
export function parseJlistStdout(stdout) {
  const hasArrayLiteral = typeof stdout === 'string' && (stdout.includes('[{') || /\[\](?![0-9])/.test(stdout));
  if (!hasArrayLiteral) return null;
  const list = safeJSONParse(extractJSONArray(stdout), null);
  return Array.isArray(list) ? list : null;
}

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

  let promise;

  if (!pm2Home) {
    // Default PM2_HOME: use PM2 Node.js API directly — no subprocess spawn, no cmd windows
    promise = new Promise((resolve) => {
      pm2.connect((err) => {
        if (err) {
          jlistInflight.delete(key);
          resolve(null);
          return;
        }
        pm2.list((err, list) => {
          pm2.disconnect();
          jlistInflight.delete(key);
          if (err || !Array.isArray(list)) {
            resolve(null);
            return;
          }
          jlistCache.set(key, { data: list, ts: Date.now() });
          resolve(list);
        });
      });
    });
  } else {
    // Custom PM2_HOME: must use CLI since the Node.js API only supports the default home
    promise = new Promise((resolve) => {
      const child = spawnPm2(['jlist'], {
        env: buildEnv(pm2Home)
      });
      let stdout = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.on('close', (code) => {
        jlistInflight.delete(key);
        if (code !== 0) {
          resolve(null);
          return;
        }
        const list = parseJlistStdout(stdout);
        if (list === null) {
          resolve(null);
          return;
        }
        jlistCache.set(key, { data: list, ts: Date.now() });
        resolve(list);
      });

      child.on('error', () => {
        jlistInflight.delete(key);
        resolve(null);
      });
    });
  }

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
 * "nothing running" (CLAUDE.md absent-vs-empty rule) — collapsing them records
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
  return new Promise((resolve, reject) => {
    const args = ['logs', name, '--lines', String(lines), '--nostream', '--raw'];
    const child = spawnPm2(args, {
      env: buildEnv(pm2Home)
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0 && stderr) {
        return reject(new Error(stderr));
      }
      resolve(stdout);
    });

    child.on('error', reject);
  });
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
 */
export async function startWithCommand(name, cwd, command, options = {}) {
  const { autorestart = true, maxRestarts = 10 } = options;
  // Parse with quote-awareness so `node --opt "arg with spaces"` survives;
  // a bare split(' ') would shred quoted segments. PM2 accepts `args` as an
  // array, which avoids re-joining and re-splitting on the way through.
  const [script, ...args] = parseCommandArgs(command);

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
        // exiting cleanly should stay stopped, not be nursed back up.
        ...(autorestart ? { max_restarts: maxRestarts, min_uptime: '10s', restart_delay: 5000 } : {}),
        max_memory_restart: '500M',
        windowsHide: IS_WIN
      };

      // On Windows, non-JS scripts (.cmd batch files) can't be fork'd by PM2
      if (IS_WIN && !isJsScript(script)) {
        opts.interpreter = 'none';
      }

      pm2.start(opts, (err, proc) => {
        if (err) return reject(err);
        resolve({ success: true, process: proc });
      });
    });
  });
}

/**
 * Spawn pm2 start with an ecosystem config file
 * @param {string} cwd Working directory
 * @param {string} ecosystemFile Config filename
 * @param {string[]} processNames Processes to start (--only flag)
 * @param {string} pm2Home Optional custom PM2_HOME
 */
function spawnPm2StartEcosystem(cwd, ecosystemFile, processNames, pm2Home) {
  return new Promise((resolve, reject) => {
    const args = ['start', ecosystemFile];
    if (processNames.length > 0) {
      args.push('--only', processNames.join(','));
    }

    const child = spawnPm2(args, {
      cwd,
      env: buildEnv(pm2Home)
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || `pm2 start exited with code ${code}`));
      }
      resolve({ success: true, output: stdout });
    });

    child.on('error', reject);
  });
}

/**
 * Start app(s) using ecosystem.config.cjs/js file
 * This properly uses all env vars, scripts, args defined in the config
 * @param {string} cwd Working directory containing ecosystem config
 * @param {string[]} processNames Optional: specific processes to start (--only flag)
 * @param {string} pm2Home Optional custom PM2_HOME path
 */
export async function startFromEcosystem(cwd, processNames = [], pm2Home = null) {
  const ecosystemFile = ['ecosystem.config.cjs', 'ecosystem.config.js']
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
 * Windows-specific ecosystem start: loads config, patches non-JS scripts
 * with interpreter:'none' so PM2 spawns them instead of forking (which would
 * try to require() .cmd batch files as JavaScript).
 */
async function startFromEcosystemWindows(cwd, ecosystemFile, processNames, pm2Home) {
  const configPath = join(cwd, ecosystemFile);

  // Try to load and patch the config
  let config;
  try {
    const require = createRequire(configPath);
    // Clear module cache to get fresh config on repeated starts
    try { delete require.cache[require.resolve(configPath)]; } catch {}
    config = require(configPath);
  } catch (err) {
    // If we can't load the config (syntax error, missing deps, etc.),
    // fall back to unpatched start — PM2 may still handle it
    console.log(`⚠️ Could not load ${ecosystemFile} for Windows patching: ${err.message}`);
    return spawnPm2StartEcosystem(cwd, ecosystemFile, processNames, pm2Home);
  }

  const apps = config.apps || [];
  let needsPatch = false;

  for (const app of apps) {
    // Skip apps not in our target list
    if (processNames.length > 0 && !processNames.includes(app.name)) continue;

    // Patch non-JS scripts to use interpreter:'none' (spawn instead of fork)
    if (app.script && !isJsScript(app.script) && app.interpreter !== 'none') {
      app.interpreter = 'none';
      needsPatch = true;
    }

    // Ensure windowsHide and restart safety on all apps
    if (!app.windowsHide) {
      app.windowsHide = true;
      needsPatch = true;
    }
    if (app.autorestart !== false && !app.max_restarts) {
      app.max_restarts = 10;
      needsPatch = true;
    }
  }

  if (!needsPatch) {
    // No modifications needed — use original config as-is
    return spawnPm2StartEcosystem(cwd, ecosystemFile, processNames, pm2Home);
  }

  // Write patched config to a temp file.
  // JSON.stringify is safe here because require() already executed the CJS module,
  // resolving all dynamic expressions (__dirname, path.join, process.env) to plain
  // string/number/boolean values. The resulting apps array has no functions or symbols.
  const tempFile = `_portos_pm2_${process.pid}_${Date.now()}.config.cjs`;
  const tempPath = join(cwd, tempFile);

  try {
    const content = `module.exports = ${JSON.stringify({ apps }, null, 2)};\n`;
    await writeFile(tempPath, content);
    console.log(`🔧 Patched ${ecosystemFile} for Windows → ${tempFile}`);
    return await spawnPm2StartEcosystem(cwd, tempFile, processNames, pm2Home);
  } finally {
    // spawnPm2StartEcosystem resolves on child 'close' (PM2 CLI has exited, config already loaded).
    // Small delay as extra safety before removing the temp file.
    await new Promise(r => setTimeout(r, 500));
    await unlink(tempPath).catch(() => {});
  }
}
