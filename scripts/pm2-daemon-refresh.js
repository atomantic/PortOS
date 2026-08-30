/**
 * "Does the running PM2 daemon still need a `pm2 update`?"
 *
 * `pm2 update` reloads the daemon in place — it kills the God process and
 * resurrects everything from the dump. That refreshes the daemon's cached
 * ProcessContainerFork.js path (a stale path from a daemon originally launched
 * by another project — e.g. a Yarn PnP zip cache — makes every subsequent
 * fork() crash with MODULE_NOT_FOUND), but it also RESTARTS every co-located
 * app on the machine. PortOS shares one PM2 daemon with whatever else the user
 * runs, so paying that cost on every self-update interrupts unrelated projects
 * for a refresh they almost never need.
 *
 * They need it only when the live daemon is not the one this checkout's
 * node_modules would launch: a different install path, or a different pm2
 * version. This probe answers that question so update.sh / update.ps1 can run
 * `pm2 update` in exactly that case and leave the daemon alone otherwise.
 *
 * Usage as a CLI (what update.sh and update.ps1 call):
 *   node scripts/pm2-daemon-refresh.js
 *
 * Exit 0  → refresh needed, run `pm2 update`.
 * Exit 1  → daemon already matches this checkout, skip it.
 *
 * Fails OPEN: anything unexpected (no report, an RPC error, an unrecognized
 * argv shape) exits 0 and restores the unconditional behavior. A needless
 * daemon reload is an annoyance; skipping a needed one leaves PortOS unable to
 * fork a single app.
 */

import { readFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// APFS and NTFS are case-insensitive, and the daemon's argv is whatever spelling
// launched it — realpath + case-fold so two spellings of one file compare equal.
const normalizePath = (path) => {
  let resolved = path;
  try {
    resolved = realpathSync(path);
  } catch {
    // Path no longer exists (node_modules wiped since the daemon launched) —
    // compare the literal spelling rather than giving up.
  }
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved;
};

/**
 * The `lib/Daemon.js` entry out of the daemon's own process.argv.
 * @param {string[]|string} argv - `report.argv` (array; string-joined on older daemons)
 * @returns {string|null} the Daemon.js path, or null when argv has no recognizable entry
 */
export function daemonEntryFromArgv(argv) {
  const parts = Array.isArray(argv) ? argv : typeof argv === 'string' ? argv.split(',') : [];
  // Trim before matching AND return the trimmed value — a comma-joined argv leaves
  // a leading space on every part after the first, and realpath() rejects ' /path',
  // which would compare as a mismatch and force a needless daemon reload.
  return parts.map((part) => String(part).trim()).find((part) => /Daemon\.js$/.test(part)) ?? null;
}

/**
 * Whether the live daemon has to be reloaded to match this checkout.
 * @param {object} options
 * @param {object|null} options.report - the daemon's `getReport` payload
 * @param {string} options.expectedEntry - path to this checkout's pm2 lib/Daemon.js
 * @param {string} options.expectedVersion - this checkout's installed pm2 version
 * @returns {{ needed: boolean, reason: string }}
 */
export function daemonNeedsRefresh({ report, expectedEntry, expectedVersion }) {
  if (!report) return { needed: true, reason: 'daemon did not report its identity' };

  const entry = daemonEntryFromArgv(report.argv);
  if (!entry) return { needed: true, reason: 'daemon argv has no Daemon.js entry' };
  if (normalizePath(entry) !== normalizePath(expectedEntry)) {
    return { needed: true, reason: 'daemon runs from a different pm2 install' };
  }

  // A version mismatch means node_modules was upgraded under a daemon still
  // executing the old code — the CLI would talk to a daemon it no longer matches.
  if (report.pm2_version !== expectedVersion) {
    return {
      needed: true,
      reason: `daemon is pm2 ${report.pm2_version}, this checkout has ${expectedVersion}`,
    };
  }

  return { needed: false, reason: 'daemon already runs this checkout of pm2' };
}

// A wedged daemon must not hang the self-update: update.sh runs this inline with
// no timeout of its own, so an RPC that never answers would stall the whole
// update indefinitely. Bound it and let the caller's catch fail open instead.
const PROBE_TIMEOUT_MS = 15000;

const withTimeout = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
};

async function fetchReport(pm2) {
  await withTimeout(
    new Promise((resolve, reject) => {
      pm2.connect((err) => (err ? reject(err) : resolve()));
    }),
    PROBE_TIMEOUT_MS,
    'pm2 connect',
  );
  try {
    return await withTimeout(
      new Promise((resolve, reject) => {
        pm2.Client.executeRemote('getReport', {}, (err, report) => (err ? reject(err) : resolve(report)));
      }),
      PROBE_TIMEOUT_MS,
      'pm2 getReport',
    );
  } finally {
    pm2.disconnect();
  }
}

/**
 * Replace this install's own paths in a probe error before it is logged.
 *
 * A pm2 socket or package-read failure names absolute paths, and update.sh
 * appends everything here to data/update.log — which backups sweep up. The
 * repo-root and home substitutions keep the message diagnostic (which file,
 * which errno) without carrying the OS username off the machine.
 * @param {string} message
 */
export function redactPaths(message) {
  const home = homedir();
  return String(message ?? '')
    // Repo root first — it lives under home, so the broader rule would eat it.
    .split(ROOT_DIR)
    .join('<repo>')
    .split(home)
    .join('~');
}

async function runCli() {
  let verdict = { needed: true, reason: 'could not inspect the running daemon' };
  try {
    const pm2Dir = join(ROOT_DIR, 'node_modules', 'pm2');
    const { default: pm2 } = await import('pm2');
    verdict = daemonNeedsRefresh({
      report: await fetchReport(pm2),
      expectedEntry: join(pm2Dir, 'lib', 'Daemon.js'),
      expectedVersion: JSON.parse(readFileSync(join(pm2Dir, 'package.json'), 'utf8')).version,
    });
  } catch (err) {
    verdict = { needed: true, reason: `daemon probe failed: ${redactPaths(err.message)}` };
  }
  console.log(`${verdict.needed ? '🔄' : '✅'} PM2 daemon refresh ${verdict.needed ? 'needed' : 'skipped'}: ${verdict.reason}`);
  return verdict.needed ? 0 : 1;
}

if (isDirectlyInvoked(import.meta.url)) process.exit(await runCli());
