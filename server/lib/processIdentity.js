/**
 * Synchronous process liveness and start-time probe used to tell a live owner from a recycled PID.
 *
 * `processStartedAt(pid)` returns the OS-reported start time in epoch ms, or `null` when it cannot be
 * established (probe failure is never evidence of death). For a valid PID, `processLiveness(pid)`
 * returns `'dead'` only when the OS proves absence. Permission and other probe failures remain live.
 */
import { isPidConfirmedDead, isProbeablePid } from './processLiveness.js';
import { execFileSync } from './childProcess.js';

const PROBE_TIMEOUT_MS = 5000;

export function processLiveness(pid, { kill = process.kill } = {}) {
  return !isProbeablePid(pid) || isPidConfirmedDead(pid, { kill }) ? 'dead' : 'alive';
}

export function processStartedAt(pid, { platform = process.platform, run = (...args) => execFileSync(...args) } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'win32') {
      const out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
      { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
      const ms = Date.parse(String(out).trim());
      return Number.isFinite(ms) ? ms : null;
    }
    // `lstart` is fixed-format under LC_ALL=C and has one-second resolution; both the
    // recorded and the probed value come from this same source so they compare exactly.
    const out = run('ps', ['-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
    const ms = Date.parse(String(out).trim());
    return Number.isFinite(ms) ? ms : null;
  } catch { return null; }
}
