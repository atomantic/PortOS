/** Read OS process tables and match detached jobs to their expected command lines. */

import { basename } from 'path';
import { promisify } from 'util';
import { execFile } from './childProcess.js';
import { safeChildProcessOptions } from './processEnv.js';

const execFileAsync = promisify(execFile);

// Quote one argv entry for a Windows command line (CommandLineToArgvW rules).
// Windows PowerShell 5.1 runs on .NET Framework, whose ProcessStartInfo has
// only the flat `Arguments` string — no `ArgumentList` — so a single correctly
// quoted string is the only faithful way to carry an argv containing spaces.
export const quoteWindowsArg = (arg) => {
  const s = String(arg);
  if (s.length > 0 && !/[\s"]/.test(s)) return s;
  // Backslashes are literal EXCEPT in the run immediately before a quote (the
  // embedded ones and the closing one), where each must be doubled.
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
};

// Process-table snapshot, POSIX only. `lstart` is fixed-format under LC_ALL=C;
// an unparseable row throws rather than being skipped, because a skipped row
// could be exactly the surviving writer a caller is looking for.
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s?(.*)$/;
export async function snapshotProcesses() {
  if (process.platform === 'win32') throw new Error('Process-group snapshots are unavailable on Windows');
  const { stdout } = await execFileAsync('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'command='],
    safeChildProcessOptions({ timeout: 15000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }));
  const rows = stdout.split('\n').filter(line => line.trim()).map((line) => {
    const match = PS_ROW.exec(line);
    const startedAt = match ? Date.parse(match[5]) : NaN;
    if (!match || !Number.isFinite(startedAt)) throw new Error('Unreadable process table');
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), state: match[4], startedAt, command: match[6] };
  });
  if (!rows.some(row => row.pid === process.pid)) throw new Error('Incomplete process table');
  return rows;
}

/** Cross-platform process identities and commands for maintenance/survivor checks. */
export async function snapshotMaintenanceProcesses({ platform = process.platform, run = execFileAsync, selfPid = process.pid } = {}) {
  if (platform !== 'win32') return snapshotProcesses();
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,@{Name="StartedAt";Expression={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString("o")}}} | ConvertTo-Json -Compress'],
  { timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
  const decoded = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  const records = Array.isArray(decoded) ? decoded : [decoded];
  const rows = records.map(row => ({ pid: Number(row?.ProcessId), ppid: Number(row?.ParentProcessId) || null, state: 'S', command: row?.CommandLine ?? '',
    startedAt: row?.StartedAt ? Date.parse(row.StartedAt) : null }));
  if (rows.some(row => !Number.isSafeInteger(row.pid) || row.pid <= 0)
    || !rows.some(row => row.pid === selfPid && row.command)) throw new Error('Incomplete process table');
  return rows;
}

// Signal a whole process group; false when it no longer exists.
export const signalProcessGroup = (pgid, signal) => {
  try { process.kill(-pgid, signal); return true; } catch (err) {
    if (err.code === 'ESRCH') return false;
    throw err;
  }
};

export const processCommandMatches = (command, { executable, args }) => {
  // A zombie still owns its PID, so it cannot be a recycled unrelated process.
  // Keep the control dir blocked until the supervisor writes the exit sentinel;
  // otherwise its late write can land in a newly-truncated control directory.
  if (/(?:^|\s)<(?:defunct|exiting)>(?:\s|$)/.test(command)) return true;
  const actualExecutable = command.split(/\s+/, 1)[0];
  if (basename(actualExecutable) !== basename(executable)) return false;
  if (!Array.isArray(args)) return true;
  const actualArgs = command.slice(actualExecutable.length).trim();
  return actualArgs === args.map(String).join(' ');
};

// Split a Windows command line into its executable and the rest. The image path
// is quoted whenever it contains a space, which is the common case for
// `C:\Program Files\…` — a plain whitespace split would take `C:\Program` as
// the executable and leave `Files\nodejs\node.exe` in the arguments.
const splitWindowsCommand = (command) => {
  if (command.startsWith('"')) {
    const end = command.indexOf('"', 1);
    if (end === -1) return { executable: command.slice(1), rest: '' };
    return { executable: command.slice(1, end), rest: command.slice(end + 1).trim() };
  }
  const space = command.search(/\s/);
  if (space === -1) return { executable: command, rest: '' };
  return { executable: command.slice(0, space), rest: command.slice(space).trim() };
};

// The win32 counterpart of processCommandMatches. `tasklist` reports only the
// image name, and PortOS runs many `node.exe` processes at once (the pm2 daemon,
// the server, the autofixer, the browser, every agent CLI) — so an image-only
// check would accept any of them as the job and leave the control dir blocked
// for good. Read the full command line instead, so the caller's `args` mean here
// what they mean on POSIX: `appUpdater` passes `{ executable: node, args: [the
// dashboard script] }` precisely to tell its handoff apart from that crowd.
//
// The comparison can be exact rather than fuzzy because we built the launched
// command line ourselves: `Start-Process` quotes the bin and appends the
// `quoteWindowsArg`-joined argument string verbatim, so re-quoting the expected
// argv reproduces it byte for byte.
//
// One PowerShell SPAWN per call. Fine for the one-per-launch probes that reach
// it today; a fan-out or polled caller must instead take a single
// `Get-CimInstance Win32_Process` snapshot and match every PID against it.
//
// A loaded CI runner can leave this CIM query slower than a snappy timeout
// tolerates (#8138) — a caller reads a thrown/timed-out query the same as any
// other probe failure (fail-closed, rethrown — see processMatches below), so
// a merely-slow host must not be treated as "job identity unknown" on the
// first hiccup. Give it real headroom and one retry before letting the error
// propagate.
const CIM_QUERY_TIMEOUT_MS = 15000;
const queryWin32Command = async (pid, attempt = 0) => {
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      // `pid` is already parsed by Number.parseInt and range-checked by every
      // caller, so it cannot carry anything but digits into this filter.
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue; if ($p) { [Console]::Out.WriteLine($p.CommandLine) }`,
    ], safeChildProcessOptions({ timeout: CIM_QUERY_TIMEOUT_MS }));
    return stdout;
  } catch (err) {
    if (attempt === 0) {
      console.warn(`⚠️ CIM process query for pid ${pid} failed, retrying once: ${err.message}`);
      return queryWin32Command(pid, 1);
    }
    throw err;
  }
};
const processMatchesWin32 = async (pid, { executable, args }) => {
  const stdout = await queryWin32Command(pid);
  const command = stdout.trim();
  // The process exited between the liveness probe and here, or Windows refused
  // the query — either way this is not our job.
  if (!command) return false;
  const actual = splitWindowsCommand(command);
  const normalize = (value) => basename(value).toLowerCase().replace(/\.exe$/, '');
  if (normalize(actual.executable) !== normalize(executable)) return false;
  if (!Array.isArray(args)) return true;
  return actual.rest === args.map(quoteWindowsArg).join(' ');
};

export const processMatches = async (pid, expectedProcess) => {
  if (process.platform === 'win32') return processMatchesWin32(pid, expectedProcess);
  const { stdout } = await execFileAsync(
    'ps', ['-ww', '-p', String(pid), '-o', 'command='], safeChildProcessOptions({ timeout: 5000 })
  ).catch((err) => {
    // The process may exit between kill(pid, 0) and ps. That is a normal
    // not-running answer; every other probe failure must remain fail-closed.
    if (err?.code === 1) return { stdout: '' };
    throw err;
  });
  const command = stdout.trim();
  if (!command) return false;
  return processCommandMatches(command, expectedProcess);
};
