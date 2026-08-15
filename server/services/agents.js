import { exec, execFile } from '../lib/childProcess.js';
import { promisify } from 'util';
import { getSpawnedAgent } from './agentState.js';
import { killAgent } from './agentOrchestrator.js';

const execAsync = promisify(exec);
// execFile (not exec) for the Windows probe: the PowerShell script rides as a
// single argv element instead of through a shell command line.
const execFileAsync = promisify(execFile);

// Agent process patterns to detect
const AGENT_PATTERNS = [
  { name: 'Claude', pattern: 'claude', command: 'claude' },
  { name: 'Codex', pattern: 'codex', command: 'codex' },
  { name: 'Antigravity', pattern: 'agy', command: 'agy' },
  { name: 'Gemini', pattern: 'gemini', command: 'gemini' },
  { name: 'Aider', pattern: 'aider', command: 'aider' },
  { name: 'Cursor', pattern: 'cursor', command: 'cursor' },
  { name: 'Copilot', pattern: 'copilot', command: 'copilot' }
];

/**
 * Decide whether a matched process line is a real AI-agent CLI or an OS/UI
 * helper that only happens to share a substring with an agent name.
 *
 * The pattern grep is a coarse substring match, so `cursor` also matches macOS
 * native helpers like the TextInputUI framework's `CursorUIViewService.xpc`
 * (a text-caret UI service, NOT the Cursor AI editor). Those live under system
 * framework / XPC-service / app-bundle paths that no agent CLI is ever invoked
 * from, so we exclude the whole class rather than blacklisting one binary.
 */
export function isAgentProcessCommand(command) {
  if (!command) return false;
  // Our own scanner and the grep it pipes through.
  if (command.includes('grep') || command.includes('ps -eo')) return false;
  // macOS app bundles (e.g. Cursor.app) and their embedded helpers, plus the
  // system framework / XPC-service helpers those bundles spawn — none of these
  // is an agent CLI, they just share a name substring (e.g. CursorUIViewService).
  if (command.includes('.app/Contents/')) return false;
  if (command.includes('/System/Library/')) return false;
  if (command.includes('.framework/')) return false;
  if (command.includes('.xpc/')) return false;
  return true;
}

/**
 * Get list of running agent processes
 */
export async function getRunningAgents() {
  const agents = [];

  for (const agent of AGENT_PATTERNS) {
    const procs = await findProcesses(agent.pattern);
    procs.forEach(proc => {
      // Enrich with spawned command data if available
      const spawnedData = getSpawnedAgent(proc.pid);

      agents.push({
        ...proc,
        agentName: agent.name,
        agentType: agent.command,
        // Override command with full command if we have it
        command: spawnedData?.fullCommand || proc.command,
        // Include additional metadata if available
        ...(spawnedData && {
          agentId: spawnedData.agentId,
          taskId: spawnedData.taskId,
          model: spawnedData.model,
          workspacePath: spawnedData.workspacePath,
          prompt: spawnedData.prompt,
          registeredAt: spawnedData.registeredAt,
          source: 'cos'
        })
      });
    });
  }

  // Sort by start time (newest first)
  agents.sort((a, b) => b.startTime - a.startTime);

  return agents;
}

/**
 * Find processes matching a pattern
 */
async function findProcesses(pattern) {
  const platform = process.platform;

  if (platform === 'darwin' || platform === 'linux') {
    return findUnixProcesses(pattern);
  } else if (platform === 'win32') {
    return findWindowsProcesses(pattern);
  }

  return [];
}

/**
 * Validate pattern to prevent command injection
 * Only allows alphanumeric characters, hyphens, and underscores
 */
function validatePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern) {
    return null;
  }
  // Only allow safe characters for process name matching
  // Reject any shell metacharacters
  if (!/^[a-zA-Z0-9_-]+$/.test(pattern)) {
    return null;
  }
  return pattern;
}

/**
 * Find processes on Unix-like systems (macOS, Linux)
 */
async function findUnixProcesses(pattern) {
  // Security: Validate pattern to prevent command injection
  const safePattern = validatePattern(pattern);
  if (!safePattern) {
    console.warn(`⚠️ Invalid process pattern rejected: ${pattern}`);
    return [];
  }

  // ps command to get process info
  // -e: all processes, -o: output format, -ww: unlimited width (no truncation)
  // Security: Pattern is validated above to only contain safe characters
  const cmd = `ps -ww -eo pid,ppid,%cpu,%mem,etime,command | grep -i "${safePattern}" | grep -v grep`;

  const result = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024, windowsHide: true }).catch(() => ({ stdout: '' }));

  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const processes = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 6) {
      const pid = parseInt(parts[0], 10);
      const ppid = parseInt(parts[1], 10);
      const cpu = parseFloat(parts[2]);
      const mem = parseFloat(parts[3]);
      const etime = parts[4];
      const command = parts.slice(5).join(' ');

      // Skip grep, our own scanner, macOS app bundles, and the system
      // framework / XPC helpers that only match a name substring (e.g. the
      // native CursorUIViewService, not the Cursor AI editor).
      if (!isAgentProcessCommand(command)) continue;

      // Parse elapsed time to get start time
      const runtime = parseElapsedTime(etime);

      processes.push({
        pid,
        ppid,
        cpu,
        memory: mem,
        runtime,
        runtimeFormatted: formatRuntime(runtime),
        command,
        startTime: Date.now() - runtime
      });
    }
  }

  return processes;
}

/**
 * Find processes on Windows
 */
async function findWindowsProcesses(pattern) {
  // Security: Validate pattern to prevent command injection
  const safePattern = validatePattern(pattern);
  if (!safePattern) {
    console.warn(`⚠️ Invalid process pattern rejected: ${pattern}`);
    return [];
  }

  // WMIC, not PowerShell CIM, was the original implementation here — but
  // Microsoft removed wmic.exe from Windows 11 (it is gone entirely on 24H2+
  // / build 26xxx), so the command failed with ENOENT, the `.catch()` below
  // swallowed it into an empty string, and getRunningAgents() reported "no
  // agents running" forever instead of surfacing an error. Get-CimInstance is
  // the documented successor, ships in-box on every supported Windows, and
  // returns ISO-8601 CreationDate (rather than wmic's `YYYYMMDDHHmmss.ffffff`),
  // which Date.parse handles directly.
  //
  // Security: safePattern is validated above to contain only safe characters,
  // and the script is passed as a single argv element to powershell -Command
  // rather than through a shell, so there is no interpolation boundary to
  // escape past.
  // CreationDate is projected through .ToString('o') rather than emitted raw:
  // Windows PowerShell 5.1 serializes a DateTime as "\/Date(1786...)\/" while
  // PowerShell 7 emits ISO-8601, and `powershell` resolves to whichever is
  // installed. Formatting it in the script pins one shape for both hosts.
  const script = `Get-CimInstance Win32_Process -Filter "Name LIKE '%${safePattern}%'" `
    + "| Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine,"
    + "@{Name='CreationDate';Expression={$_.CreationDate.ToString('o')}} "
    + '| ConvertTo-Json -Compress';

  const result = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  ).catch((err) => {
    // Keep the empty-result behavior (the caller treats [] as "none running"),
    // but never again fail SILENTLY — a broken process probe is why this was
    // undiagnosable for so long.
    console.error(`❌ Windows process probe failed for "${safePattern}": ${err.message}`);
    return { stdout: '' };
  });

  const raw = String(result.stdout || '').trim();
  if (!raw) return [];

  // ConvertTo-Json emits a bare object (not a 1-element array) for a single
  // match, so normalize before iterating.
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`❌ Windows process probe returned unparseable JSON for "${safePattern}": ${err.message}`);
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  const processes = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const pid = parseInt(row.ProcessId, 10);
    if (!Number.isFinite(pid)) continue;

    const startTime = parseWindowsDate(row.CreationDate);
    const runtime = Date.now() - startTime;

    processes.push({
      pid,
      ppid: parseInt(row.ParentProcessId, 10) || 0,
      // Win32_Process carries no CPU% column (the old wmic query asked for a
      // PercentProcessorTime that class never had, so this was always 0).
      cpu: 0,
      memory: (parseInt(row.WorkingSetSize, 10) || 0) / 1024 / 1024, // → MB
      runtime,
      runtimeFormatted: formatRuntime(runtime),
      command: row.CommandLine || '',
      startTime,
    });
  }

  return processes;
}

/**
 * Parse Unix elapsed time format (HH:MM:SS or MM:SS or SS)
 */
function parseElapsedTime(etime) {
  const parts = etime.split(':').map(p => parseInt(p.replace(/-/g, ''), 10));

  if (etime.includes('-')) {
    // Days-HH:MM:SS format
    const [days, rest] = etime.split('-');
    const timeParts = rest.split(':').map(p => parseInt(p, 10));
    const d = parseInt(days, 10);
    const [h, m, s] = timeParts.length === 3 ? timeParts : [0, ...timeParts];
    return ((d * 24 + h) * 60 + m) * 60 * 1000 + s * 1000;
  }

  if (parts.length === 3) {
    // HH:MM:SS
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  } else if (parts.length === 2) {
    // MM:SS
    return (parts[0] * 60 + parts[1]) * 1000;
  }

  return parts[0] * 1000;
}

/**
 * Parse Windows date format
 */
function parseWindowsDate(dateStr) {
  if (!dateStr) return Date.now();
  // Get-CimInstance | ConvertTo-Json emits ISO-8601 with an offset
  // ("2026-08-13T21:51:42.098512+00:00"); the legacy wmic path emitted
  // `YYYYMMDDHHmmss.ffffff`. Accept both — the ISO branch must come first,
  // because the positional parse below would happily read "2026-08-13T2" as a
  // date and return garbage rather than failing.
  // Windows PowerShell 5.1's raw DateTime serialization, kept as a fallback for
  // any caller that doesn't project through .ToString('o').
  const epoch = /^\/Date\((-?\d+)\)\/$/.exec(dateStr);
  if (epoch) return Number(epoch[1]);
  if (dateStr.includes('-') || dateStr.includes('T')) {
    const iso = Date.parse(dateStr);
    if (Number.isFinite(iso)) return iso;
  }
  // Format: YYYYMMDDHHmmss.ffffff
  const year = parseInt(dateStr.substring(0, 4), 10);
  const month = parseInt(dateStr.substring(4, 6), 10) - 1;
  const day = parseInt(dateStr.substring(6, 8), 10);
  const hour = parseInt(dateStr.substring(8, 10), 10);
  const min = parseInt(dateStr.substring(10, 12), 10);
  const sec = parseInt(dateStr.substring(12, 14), 10);
  return new Date(year, month, day, hour, min, sec).getTime();
}

/**
 * Format runtime in human-readable format
 */
function formatRuntime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Kill a process by PID.
 * If the process is a CoS-spawned agent, delegates to the CoS killAgent
 * transition (via the `agentOrchestrator` facade) so the task is properly
 * blocked instead of requeued.
 */
export async function killProcess(pid) {
  // Security: Ensure PID is a valid integer to prevent command injection
  const safePid = parseInt(pid, 10);
  if (isNaN(safePid) || safePid <= 0) {
    throw new Error('Invalid PID provided');
  }

  // Check if this PID belongs to a CoS-spawned agent
  const spawnedData = getSpawnedAgent(safePid);
  if (spawnedData?.agentId) {
    console.log(`🔪 PID ${safePid} is CoS agent ${spawnedData.agentId}, delegating to CoS killAgent`);
    // killAgent throws a ServerError when the agent is missing or the kill
    // fails; treat that as "already gone" and fall through to the raw kill
    // below rather than surfacing it — this path is a best-effort cleanup.
    const killed = await killAgent(spawnedData.agentId).then(() => true, (err) => {
      console.log(`⚠️ CoS killAgent failed for ${spawnedData.agentId}: ${err.message}, falling back to raw kill`);
      return false;
    });
    if (killed) return true;
  }

  const platform = process.platform;

  if (platform === 'win32') {
    await execAsync(`taskkill /PID ${safePid} /F`, { windowsHide: true });
  } else {
    await execAsync(`kill -9 ${safePid}`, { windowsHide: true });
  }

  console.log(`🔪 Killed process ${safePid}`);
  return true;
}

/**
 * Get detailed info for a specific process
 */
export async function getProcessInfo(pid) {
  // Security: Ensure PID is a valid integer to prevent command injection
  const safePid = parseInt(pid, 10);
  if (isNaN(safePid) || safePid <= 0) {
    return null;
  }

  const platform = process.platform;

  if (platform === 'darwin' || platform === 'linux') {
    const cmd = `ps -ww -p ${safePid} -o pid,ppid,%cpu,%mem,etime,command`;
    const result = await execAsync(cmd, { windowsHide: true }).catch(() => null);
    if (!result) return null;

    const lines = result.stdout.trim().split('\n');
    if (lines.length < 2) return null;

    const parts = lines[1].trim().split(/\s+/);
    return {
      pid: parseInt(parts[0], 10),
      ppid: parseInt(parts[1], 10),
      cpu: parseFloat(parts[2]),
      memory: parseFloat(parts[3]),
      runtime: parseElapsedTime(parts[4]),
      command: parts.slice(5).join(' ')
    };
  }

  return null;
}
