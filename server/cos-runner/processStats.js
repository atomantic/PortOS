/**
 * CoS Runner — Process inspection layer
 *
 * Reads live CPU/memory stats and liveness for spawned agent PIDs via `ps`
 * (or `tasklist` on Windows). PID inputs are integer-validated before being
 * interpolated into the command to prevent injection. Self-contained so the
 * isolated `portos-cos` PM2 process stays standalone.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Get process stats (CPU, memory) for a PID.
 * Returns { active, pid, cpu, memoryKb, memoryMb?, state }.
 */
export async function getProcessStats(pid) {
  // Security: Ensure PID is a valid integer to prevent command injection
  const safePid = parseInt(pid, 10);
  if (isNaN(safePid) || safePid <= 0) {
    return { active: false, pid, cpu: 0, memoryKb: 0, state: 'invalid' };
  }

  // Get process stats using ps command
  // %cpu = CPU percentage, rss = resident set size in KB
  const psCmd = process.platform === 'win32'
    ? `tasklist /FI "PID eq ${safePid}" /FO CSV /NH`
    : `ps -p ${safePid} -o pid=,pcpu=,rss=,state=`;
  const result = await execAsync(psCmd, { windowsHide: true }).catch(() => ({ stdout: '' }));
  const line = result.stdout.trim();

  if (!line) {
    return { active: false, pid, cpu: 0, memoryKb: 0, state: 'dead' };
  }

  const parts = line.split(/\s+/).filter(Boolean);
  if (parts.length >= 3) {
    return {
      active: true,
      pid: parseInt(parts[0], 10),
      cpu: parseFloat(parts[1]) || 0,
      memoryKb: parseInt(parts[2], 10) || 0,
      memoryMb: Math.round((parseInt(parts[2], 10) || 0) / 1024 * 10) / 10,
      state: parts[3] || 'unknown'
    };
  }

  return { active: true, pid, cpu: 0, memoryKb: 0, state: 'unknown' };
}

/**
 * Check if a process is running by PID.
 * Uses `tasklist` on Windows and `ps` elsewhere so orphan cleanup doesn't
 * report live agents as dead on Windows installs.
 */
export async function checkProcessRunning(pid) {
  // Security: Ensure PID is a valid integer to prevent command injection
  const safePid = parseInt(pid, 10);
  if (isNaN(safePid) || safePid <= 0) {
    return false;
  }

  if (process.platform === 'win32') {
    const result = await execAsync(`tasklist /FI "PID eq ${safePid}" /FO CSV /NH`, { windowsHide: true }).catch(() => ({ stdout: '' }));
    // tasklist prints a CSV row containing the PID when the process exists;
    // otherwise it emits an "INFO: No tasks…" line that won't contain the PID.
    return result.stdout.includes(`"${safePid}"`);
  }

  const result = await execAsync(`ps -p ${safePid} -o pid=`, { windowsHide: true }).catch(() => ({ stdout: '' }));
  return result.stdout.trim() !== '';
}
