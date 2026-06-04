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

const toMemoryMb = (memoryKb) => Math.round(memoryKb / 1024 * 10) / 10;

/**
 * Parse a single `tasklist /FO CSV /NH` row into process stats.
 *
 * tasklist emits comma-delimited, double-quoted fields:
 *   "node.exe","1234","Console","1","50,000 K"
 *    image      PID    session    #    memUsage
 *
 * `/NH /FO CSV` does NOT report %CPU, so cpu is always 0 here (a different
 * source — WMIC/PowerShell — would be needed for CPU on Windows). The memory
 * column carries thousands separators and a " K" (KiB) unit, so strip every
 * non-digit before parsing. Returns null when the row isn't a parseable data
 * row (e.g. the "INFO: No tasks…" line).
 */
function parseTasklistRow(line, fallbackPid) {
  const fields = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (fields.length < 5) {
    return null;
  }
  const memoryKb = parseInt(fields[4].replace(/[^\d]/g, ''), 10) || 0;
  return {
    active: true,
    pid: parseInt(fields[1], 10) || fallbackPid,
    cpu: 0, // tasklist /NH does not report %CPU
    memoryKb,
    memoryMb: toMemoryMb(memoryKb),
    state: 'running' // tasklist row only appears for live PIDs; it carries no state column
  };
}

/**
 * Parse a single `ps -o pid=,pcpu=,rss=,state=` row into process stats.
 * Whitespace-delimited: `1234 0.5 50000 S`.
 */
function parsePsRow(line, fallbackPid) {
  const parts = line.split(/\s+/).filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  const memoryKb = parseInt(parts[2], 10) || 0;
  return {
    active: true,
    pid: parseInt(parts[0], 10) || fallbackPid,
    cpu: parseFloat(parts[1]) || 0,
    memoryKb,
    memoryMb: toMemoryMb(memoryKb),
    state: parts[3] || 'unknown'
  };
}

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

  const isWindows = process.platform === 'win32';
  // %cpu = CPU percentage, rss = resident set size in KB
  const psCmd = isWindows
    ? `tasklist /FI "PID eq ${safePid}" /FO CSV /NH`
    : `ps -p ${safePid} -o pid=,pcpu=,rss=,state=`;
  const result = await execAsync(psCmd, { windowsHide: true }).catch(() => ({ stdout: '' }));
  const line = result.stdout.trim();

  if (!line) {
    return { active: false, pid, cpu: 0, memoryKb: 0, state: 'dead' };
  }

  const parseRow = isWindows ? parseTasklistRow : parsePsRow;
  const stats = parseRow(line, safePid);
  if (stats) {
    return stats;
  }

  // No parseable data row. On Windows a non-empty-but-unparseable line is the
  // "INFO: No tasks are running…" message tasklist prints (with exit 0) when
  // the PID is gone, so report it dead — matching checkProcessRunning.
  if (isWindows) {
    return { active: false, pid: safePid, cpu: 0, memoryKb: 0, state: 'dead' };
  }
  return { active: true, pid: safePid, cpu: 0, memoryKb: 0, state: 'unknown' };
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
