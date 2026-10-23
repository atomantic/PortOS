/**
 * Which OTHER processes still hold a set of files open?
 *
 * Used before deleting staged input another process (an `ollama create` CLI,
 * the Ollama daemon) may still be reading. The answer is tri-state and fails
 * CLOSED: `known: false` whenever the probe cannot prove its own listing is
 * complete — no `lsof`, an unsupported platform, or a listing that omits the
 * canary file this process holds open for the duration of the probe.
 */

import { open } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from './childProcess.js';

const LSOF_TIMEOUT_MS = 15_000;
const LSOF_MAX_BUFFER = 4 * 1024 * 1024;

/** PIDs from `lsof -F pn` field output (`p<pid>` starts each process block). */
function parseLsofPids(stdout) {
  return String(stdout || '').split('\n')
    .filter((line) => line.startsWith('p'))
    .map((line) => Number(line.slice(1)))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * @param {string[]} files - paths to check
 * @param {{ canary: string, platform?: string, selfPid?: number,
 *   run?: (file: string, args: string[], opts: object) => Promise<{ stdout: string }> }} options
 *   `canary` must be an existing file; it is opened by this process so a
 *   listing that does not report this PID on it is rejected as incomplete.
 * @returns {Promise<{ known: true, pids: number[] } | { known: false, reason: string }>}
 */
export async function findOpenFileHolders(files, { canary, platform = process.platform, selfPid = process.pid, run = promisify(execFile) } = {}) {
  if (platform !== 'darwin' && platform !== 'linux') return { known: false, reason: `open-file probe unsupported on ${platform}` };
  if (!canary) return { known: false, reason: 'no canary file' };
  const handle = await open(canary, 'r').catch(() => null);
  if (!handle) return { known: false, reason: 'canary file unreadable' };
  // lsof exits 1 when any named file is not open (the expected case for most
  // of them) while still printing what it found. Any other failure — a
  // timeout, a signal, a maxBuffer overflow — can leave a listing truncated
  // after this PID but before a holder's, so it is never trusted.
  const out = await run('lsof', ['-F', 'pn', '--', canary, ...files], { timeout: LSOF_TIMEOUT_MS, maxBuffer: LSOF_MAX_BUFFER })
    .then((r) => r.stdout, (err) => (err?.code === 1 && !err.killed && !err.signal ? err.stdout ?? null : null))
    .finally(() => handle.close().catch(() => {}));
  const pids = out == null ? [] : parseLsofPids(out);
  if (!pids.includes(selfPid)) return { known: false, reason: 'lsof unavailable or listing incomplete' };
  return { known: true, pids: [...new Set(pids.filter((pid) => pid !== selfPid))] };
}
