/**
 * Production PM2 startup for `npm start`.
 *
 * `npm start` used to `pm2 delete` + `pm2 start` unconditionally, so running it
 * on a live install (after a pull, from a second terminal, from an agent)
 * killed every in-flight CoS agent and dropped all client sockets. The script
 * lets `npm start` leave a healthy install alone: it only needs to (re)start
 * apps that are missing or down. Applying new server code to a running install
 * stays an explicit `npm run pm2:restart` (or `npm run update`).
 *
 * Usage as a CLI (what the `start` script calls):
 *   node scripts/pm2-start.js <app,app,...>
 *
 * Keep the recovery decision here so a failed Autofixer-only upgrade exits
 * with an error without triggering a restart of healthy production services.
 */

import { execFileSync } from 'child_process';
import { realpathSync } from 'fs';
import { dirname, join, sep } from 'path';
import { fileURLToPath } from 'url';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { redactPaths } from './pm2-daemon-refresh.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_TIMEOUT_MS = 15000;
const ECOSYSTEM = 'ecosystem.config.cjs';
const AUTOFIXER = 'portos-autofixer';
const DASHBOARD_PORT = '5560';

const normalizePath = (path) => {
  let resolved = path;
  try {
    resolved = realpathSync(path);
  } catch {
    // Checkout moved or removed since launch — compare the literal spelling.
  }
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
};

const isInside = (child, root) => {
  const c = normalizePath(child);
  const r = normalizePath(root);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
};

const runsFrom = (env, root) => env?.pm_exec_path && isInside(env.pm_exec_path, root);

/**
 * Which expected apps need a (re)start.
 * @param {object} options
 * @param {Array<{name: string, pm2_env?: object}>} options.processes - PM2's process list
 * @param {string[]} options.expectedApps - production app names
 * @param {string} options.root - this checkout's root; an app launched from another
 *   checkout (a worktree, an old install path) does not count as running here
 * @returns {{ missing: string[], reasons: string[] }} `missing` is empty when nothing needs starting
 */
export function appsNeedingStart({ processes, expectedApps, root }) {
  const missing = [];
  const reasons = [];
  for (const name of expectedApps) {
    const matches = processes.filter((p) => p.name === name);
    const proc = matches.find(({ pm2_env }) => runsFrom(pm2_env, root)) ?? matches[0];
    const env = proc?.pm2_env;
    if (!env) {
      missing.push(name);
      reasons.push(`${name} is not registered`);
    } else if (env.status !== 'online') {
      missing.push(name);
      reasons.push(`${name} is ${env.status}`);
    } else if (!runsFrom(env, root)) {
      missing.push(name);
      reasons.push(`${name} runs from a different checkout`);
    }
  }
  return { missing, reasons };
}

const withTimeout = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
};

async function listProcesses(pm2) {
  await withTimeout(
    new Promise((resolve, reject) => pm2.connect((err) => (err ? reject(err) : resolve()))),
    PROBE_TIMEOUT_MS,
    'pm2 connect',
  );
  try {
    return await withTimeout(
      new Promise((resolve, reject) => pm2.list((err, list) => (err ? reject(err) : resolve(list)))),
      PROBE_TIMEOUT_MS,
      'pm2 list',
    );
  } finally {
    pm2.disconnect();
  }
}

const savedPort = ({ pm2_env: env }) => String(env?.env?.PORT ?? env?.PORT);

function retireDashboard(dashboards, pm2) {
  for (const { pm_id: id } of dashboards) {
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('Legacy Autofixer dashboard has no valid PM2 ID');
    pm2('delete', String(id));
  }
}

export async function startProductionApps({ expectedApps, root, list, pm2 }) {
  let processes = [];
  let reasons;
  try {
    const registered = await list();
    ({ reasons } = appsNeedingStart({ processes: registered, expectedApps, root }));
    processes = registered;
  } catch (err) {
    reasons = [`could not inspect PM2 (${redactPaths(err.message)})`];
  }

  // The old UI script can be gone by the time the process is retired.
  const legacyScript = normalizePath(join(root, 'autofixer', 'ui.js'));
  const dashboards = expectedApps.includes(AUTOFIXER) ? processes.filter(({ name, pm2_env: env }) =>
    name === 'portos-autofixer-ui' && env?.pm_exec_path && normalizePath(env.pm_exec_path) === legacyScript) : [];
  if (reasons.length) {
    console.log(`🔄 PM2 start needed: ${reasons.join('; ')}`);
    retireDashboard(dashboards, pm2);
    try {
      pm2('delete', ECOSYSTEM, '--silent');
    } catch {
      console.log('➡️ PM2 ecosystem delete skipped');
    }
    pm2('start', ECOSYSTEM, '--only', expectedApps.join(','));
    pm2('save');
    return;
  }

  const monitors = processes.filter(({ name }) => name === AUTOFIXER);
  const monitor = monitors.find(({ pm2_env }) => runsFrom(pm2_env, root));
  const upgradeMonitor = expectedApps.includes(AUTOFIXER) && savedPort(monitor) !== DASHBOARD_PORT;
  if (dashboards.length || upgradeMonitor) {
    if (upgradeMonitor && monitors.length !== 1) throw new Error('Multiple PM2 Autofixer monitors are registered');
    retireDashboard(dashboards, pm2);
    if (upgradeMonitor) {
      pm2('restart', ECOSYSTEM, '--only', AUTOFIXER);
      // PM2 can exit successfully after an individual ecosystem restart fails.
      const refreshed = (await list()).find(({ name }) => name === AUTOFIXER);
      if (refreshed?.pm2_env?.status !== 'online' || !runsFrom(refreshed.pm2_env, root)
        || savedPort(refreshed) !== DASHBOARD_PORT) {
        throw new Error('PM2 did not apply the combined Autofixer dashboard configuration');
      }
    }
    pm2('save');
    console.log('✅ Autofixer dashboard upgrade saved under PM2');
    return;
  }

  console.log('✅ PortOS is already running under PM2 — leaving the processes alone');
  console.log('   Client build was refreshed. To load new server code run: npm run pm2:restart');
}

async function runCli(argv) {
  const expectedApps = (argv[0] ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  if (!expectedApps.length) {
    console.error('❌ PM2 start failed: no app names were given');
    return 1;
  }
  try {
    await startProductionApps({
      expectedApps,
      root: ROOT_DIR,
      list: async () => listProcesses((await import('pm2')).default),
      pm2: (...args) => execFileSync(process.execPath, [join(ROOT_DIR, 'node_modules', 'pm2', 'bin', 'pm2'), ...args], {
        cwd: ROOT_DIR, stdio: 'inherit',
      }),
    });
    return 0;
  } catch (err) {
    console.error(`❌ PM2 start failed: ${redactPaths(err.message)}`);
    return 1;
  }
}

if (isDirectlyInvoked(import.meta.url)) process.exit(await runCli(process.argv.slice(2)));
