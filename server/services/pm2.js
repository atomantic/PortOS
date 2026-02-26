import pm2 from 'pm2';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readFile, writeFile, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { extractJSONArray, safeJSONParse } from '../lib/fileUtils.js';

const IS_WIN = process.platform === 'win32';

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
  return /\.(?:js|mjs|cjs|ts)$/.test(script);
}

/**
 * Spawn PM2 CLI via local binary (node pm2/bin/pm2).
 * Always uses the local PM2 binary to avoid depending on a global pm2 install.
 * On Windows this also avoids pm2.cmd which creates visible CMD windows.
 * @param {string[]} pm2Args PM2 CLI arguments (e.g. ['jlist'], ['start', 'ecosystem.config.cjs'])
 * @param {object} opts Spawn options (cwd, env, etc.)
 * @returns {ChildProcess}
 */
export function spawnPm2(pm2Args, opts = {}) {
  return spawn(process.execPath, [PM2_BIN, ...pm2Args], {
    ...opts,
    windowsHide: true
  });
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
  return new Promise((resolve) => {
    const child = spawnPm2(['jlist'], {
      env: buildEnv(pm2Home)
    });
    let stdout = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('close', () => {
      const processes = safeJSONParse(extractJSONArray(stdout), []);
      const proc = processes.find(p => p.name === name);

      if (!proc) {
        return resolve({
          name,
          status: 'not_found',
          pm2_env: null
        });
      }

      resolve({
        name: proc.name,
        status: proc.pm2_env?.status || 'unknown',
        pid: proc.pid,
        pm_id: proc.pm_id,
        cpu: proc.monit?.cpu || 0,
        memory: proc.monit?.memory || 0,
        uptime: proc.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null,
        restarts: proc.pm2_env?.restart_time || 0,
        createdAt: proc.pm2_env?.created_at || null
      });
    });

    child.on('error', () => {
      resolve({ name, status: 'error', pm2_env: null });
    });
  });
}

/**
 * List all PM2 processes using CLI (avoids connection deadlocks)
 * @param {string} pm2Home Optional custom PM2_HOME path
 */
export async function listProcesses(pm2Home = null) {
  return new Promise((resolve) => {
    const child = spawnPm2(['jlist'], {
      env: buildEnv(pm2Home)
    });
    let stdout = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('close', () => {
      const list = safeJSONParse(extractJSONArray(stdout), []);
      const processes = list.map(proc => ({
        name: proc.name,
        status: proc.pm2_env?.status || 'unknown',
        pid: proc.pid,
        pm_id: proc.pm_id,
        cpu: proc.monit?.cpu || 0,
        memory: proc.monit?.memory || 0,
        uptime: proc.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null,
        restarts: proc.pm2_env?.restart_time || 0
      }));
      resolve(processes);
    });

    child.on('error', () => {
      resolve([]);
    });
  });
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
 */
export async function startWithCommand(name, cwd, command) {
  const [script, ...args] = command.split(' ');

  return connectAndRun((pm2) => {
    return new Promise((resolve, reject) => {
      const opts = {
        name,
        script,
        args: args.join(' '),
        cwd,
        watch: false,
        autorestart: true,
        max_restarts: 10,
        min_uptime: '10s',
        restart_delay: 5000,
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
    app.windowsHide = true;
    if (app.autorestart !== false && !app.max_restarts) {
      app.max_restarts = 10;
    }
  }

  if (!needsPatch) {
    // All scripts are .js files, no patching needed
    return spawnPm2StartEcosystem(cwd, ecosystemFile, processNames, pm2Home);
  }

  // Write patched config to a temp file.
  // JSON.stringify is safe here because require() already executed the CJS module,
  // resolving all dynamic expressions (__dirname, path.join, process.env) to plain
  // string/number/boolean values. The resulting apps array has no functions or symbols.
  const tempFile = `_portos_pm2_${Date.now()}.config.cjs`;
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
