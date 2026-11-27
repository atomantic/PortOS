/**
 * Checkout-scoped PM2 startup for `npm start` and `npm run dev`.
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
import { dirname, isAbsolute, join, sep } from 'path';
import { fileURLToPath } from 'url';
import { PORTS } from '../server/lib/ports.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { redactPaths } from './pm2-daemon-refresh.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_TIMEOUT_MS = 15000;
const ECOSYSTEM = 'ecosystem.config.cjs';
const AUTOFIXER = 'portos-autofixer';
const COS = 'portos-cos';
const UI = 'portos-ui';
const DASHBOARD_PORT = String(PORTS.AUTOFIXER_UI);

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

const isAbsolutePath = (path) => typeof path === 'string' && isAbsolute(path);
const hasCheckoutPaths = (env) => isAbsolutePath(env?.pm_exec_path) && isAbsolutePath(env.pm_cwd);
// PortOS worktrees may be nested inside the primary checkout.
function runsFrom({ name, pm2_env: env }, root) {
  if (!hasCheckoutPaths(env)) return false;
  if (name === UI) {
    // Vite's executable may resolve into shared dependencies in a linked worktree.
    const client = join(root, 'client');
    return normalizePath(env.pm_cwd) === normalizePath(client)
      && normalizePath(env.pm_exec_path) === normalizePath(join(client, 'node_modules', 'vite', 'bin', 'vite.js'));
  }
  return normalizePath(env.pm_cwd) === normalizePath(root) && isInside(env.pm_exec_path, root);
}
const isOnlineHere = (proc, root) => proc.pm2_env?.status === 'online' && runsFrom(proc, root);

const withTimeout = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
};

export async function listPm2Processes() {
  const pm2 = (await import('pm2')).default;
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

async function inspectProcesses(list) {
  try {
    const processes = await list();
    if (!Array.isArray(processes) || processes.some(proc => typeof proc?.name !== 'string' || !proc.name)) {
      throw new Error('invalid process inventory');
    }
    return processes;
  } catch (err) {
    throw new Error(`could not inspect PM2 (${redactPaths(err.message)})`, { cause: err });
  }
}

export async function startPm2Apps({ expectedApps, root, list, pm2, development = false, restartCos = false }) {
  const processes = await inspectProcesses(list);
  const start = [];
  const restart = [];
  const retire = [];
  let refreshMonitor = false;
  for (const name of expectedApps) {
    const matches = processes.filter(proc => proc.name === name);
    if (!matches.length) {
      start.push(name);
      continue;
    }
    if (matches.some(({ pm2_env: env }) => !hasCheckoutPaths(env))) {
      throw new Error(`Cannot verify checkout ownership for PM2 app ${name}`);
    }
    if (matches.some(({ pm2_env: env }) => typeof env.status !== 'string' || !env.status)) {
      throw new Error(`Cannot verify status for PM2 app ${name}`);
    }
    if (development && name === COS && !restartCos) {
      // PM2 may already be starting the worker or waiting to restart it.
      const active = matches.some(proc => runsFrom(proc, root)
        && !['stopped', 'errored'].includes(proc.pm2_env.status));
      if (active) continue;
    }
    if (!development) {
      const online = matches.find(proc => isOnlineHere(proc, root));
      if (online && (name !== AUTOFIXER || savedPort(online) === DASHBOARD_PORT)) continue;
    }

    // Ecosystem operations address an app by name. Refuse any name collision
    // before acting, even if the other entry is stopped.
    if (matches.length !== 1) throw new Error(`Multiple PM2 entries for ${name}; cannot safely recover it`);
    const [proc] = matches;
    if (!runsFrom(proc, root)) throw new Error(`PM2 app ${name} runs from a different checkout`);
    if (development && (name !== COS || restartCos)) {
      // Recreate dev services from the current config, addressing the existing
      // entries by verified ID so broad ecosystem operations cannot stop CoS.
      retire.push(proc);
      start.push(name);
    } else if (name === AUTOFIXER && savedPort(proc) !== DASHBOARD_PORT) refreshMonitor = true;
    else restart.push(proc);
  }

  // The old UI script can be gone by the time the process is retired.
  const legacyScript = normalizePath(join(root, 'autofixer', 'ui.js'));
  retire.push(...processes.filter(proc => {
    const { name, pm2_env: env } = proc;
    if (name === 'portos-autofixer-ui' && expectedApps.includes(AUTOFIXER)) {
      return runsFrom(proc, root) && normalizePath(env.pm_exec_path) === legacyScript;
    }
    return name === UI && !expectedApps.includes(name) && runsFrom(proc, root);
  }));
  for (const { name, pm_id: id } of [...retire, ...restart]) {
    if (!Number.isSafeInteger(id) || id < 0 || processes.filter(proc => proc.pm_id === id).length !== 1) {
      throw new Error(`PM2 app ${name} has no unique valid PM2 ID`);
    }
  }

  const recovered = [...start.map(name => ({ name })), ...restart];
  if (refreshMonitor) recovered.push({ name: AUTOFIXER });
  if (!recovered.length && !retire.length) {
    console.log('✅ PortOS is already running under PM2 — leaving the processes alone');
    if (!development) console.log('   Client build was refreshed. To load new server code run: npm run pm2:restart');
    return;
  }

  for (const { pm_id: id } of retire) pm2('delete', String(id));
  for (const { pm_id: id } of restart) pm2('restart', String(id));
  if (start.length) pm2('start', ECOSYSTEM, '--only', start.join(','));
  if (refreshMonitor) pm2('restart', ECOSYSTEM, '--only', AUTOFIXER);

  // PM2 can exit successfully after an individual ecosystem action fails.
  const after = await inspectProcesses(list);
  for (const { name, pm_id: id } of recovered) {
    const online = after.find(proc => proc.name === name && (id === undefined || proc.pm_id === id)
      && isOnlineHere(proc, root));
    if (!online) throw new Error(`PM2 did not bring ${name} online from this checkout`);
    if (name === AUTOFIXER && savedPort(online) !== DASHBOARD_PORT) {
      throw new Error('PM2 did not apply the combined Autofixer dashboard configuration');
    }
  }
  for (const { name, pm_id: id } of retire) {
    if (after.some(proc => proc.name === name && proc.pm_id === id)) {
      throw new Error(`PM2 did not retire ${name}`);
    }
  }
  if (!development) {
    pm2('save');
    console.log('✅ Production startup changes saved under PM2');
  }
}

async function runCli(argv) {
  const expectedApps = (argv[0] ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  if (!expectedApps.length) {
    console.error('❌ PM2 start failed: no app names were given');
    return 1;
  }
  try {
    await startPm2Apps({
      expectedApps,
      root: ROOT_DIR,
      list: listPm2Processes,
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
