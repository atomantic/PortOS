/**
 * "Are this checkout's production apps already running under PM2?"
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
 * Exit 0  → every named app is online from this checkout, skip the start.
 * Exit 1  → something is missing/down/foreign, run the full delete + start.
 *
 * Fails OPEN: anything unexpected (daemon unreachable, RPC error) exits 1 so
 * `npm start` still starts PortOS, the way it did before this probe existed.
 */

import { realpathSync } from 'fs';
import { dirname, join, sep } from 'path';
import { fileURLToPath } from 'url';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { redactPaths } from './pm2-daemon-refresh.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_TIMEOUT_MS = 15000;

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
    const proc = processes.find((p) => p.name === name);
    const env = proc?.pm2_env;
    if (!env) {
      missing.push(name);
      reasons.push(`${name} is not registered`);
    } else if (env.status !== 'online') {
      missing.push(name);
      reasons.push(`${name} is ${env.status}`);
    } else if (!env.pm_exec_path || !isInside(env.pm_exec_path, root)) {
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

async function runCli(argv) {
  const expectedApps = (argv[0] ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  if (!expectedApps.length) {
    console.log('🔄 PM2 start needed: no app names were given to check');
    return 1;
  }
  try {
    const { default: pm2 } = await import('pm2');
    const { missing, reasons } = appsNeedingStart({ processes: await listProcesses(pm2), expectedApps, root: ROOT_DIR });
    if (missing.length) {
      console.log(`🔄 PM2 start needed: ${reasons.join('; ')}`);
      return 1;
    }
  } catch (err) {
    console.log(`🔄 PM2 start needed: could not inspect PM2 (${redactPaths(err.message)})`);
    return 1;
  }
  console.log('✅ PortOS is already running under PM2 — leaving the processes alone');
  console.log('   Client build was refreshed. To load new server code run: npm run pm2:restart');
  return 0;
}

if (isDirectlyInvoked(import.meta.url)) process.exit(await runCli(process.argv.slice(2)));
