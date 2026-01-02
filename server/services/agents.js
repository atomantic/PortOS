import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Agent process patterns to detect
const AGENT_PATTERNS = [
  { name: 'Claude', pattern: 'claude', command: 'claude' },
  { name: 'Codex', pattern: 'codex', command: 'codex' },
  { name: 'Gemini', pattern: 'gemini', command: 'gemini' },
  { name: 'Aider', pattern: 'aider', command: 'aider' },
  { name: 'Cursor', pattern: 'cursor', command: 'cursor' },
  { name: 'Copilot', pattern: 'copilot', command: 'copilot' }
];

/**
 * Get list of running agent processes
 */
export async function getRunningAgents() {
  const agents = [];

  for (const agent of AGENT_PATTERNS) {
    const procs = await findProcesses(agent.pattern);
    procs.forEach(proc => {
      agents.push({
        ...proc,
        agentName: agent.name,
        agentType: agent.command
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
 * Find processes on Unix-like systems (macOS, Linux)
 */
async function findUnixProcesses(pattern) {
  // ps command to get process info
  // -e: all processes, -o: output format
  const cmd = `ps -eo pid,ppid,%cpu,%mem,etime,command | grep -i "${pattern}" | grep -v grep`;

  const result = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 }).catch(() => ({ stdout: '' }));

  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const processes = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 6) {
      const pid = parseInt(parts[0]);
      const ppid = parseInt(parts[1]);
      const cpu = parseFloat(parts[2]);
      const mem = parseFloat(parts[3]);
      const etime = parts[4];
      const command = parts.slice(5).join(' ');

      // Skip if it's a grep or our own process
      if (command.includes('grep') || command.includes('ps -eo')) continue;

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
  const cmd = `wmic process where "name like '%${pattern}%'" get ProcessId,ParentProcessId,PercentProcessorTime,WorkingSetSize,CreationDate,CommandLine /format:csv`;

  const result = await execAsync(cmd).catch(() => ({ stdout: '' }));

  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const processes = [];

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length >= 6) {
      const command = parts[1];
      const creationDate = parts[2];
      const ppid = parseInt(parts[3]);
      const cpu = parseFloat(parts[4]) || 0;
      const memory = parseInt(parts[5]) / 1024 / 1024; // Convert to MB
      const pid = parseInt(parts[6]);

      const startTime = parseWindowsDate(creationDate);
      const runtime = Date.now() - startTime;

      processes.push({
        pid,
        ppid,
        cpu,
        memory,
        runtime,
        runtimeFormatted: formatRuntime(runtime),
        command,
        startTime
      });
    }
  }

  return processes;
}

/**
 * Parse Unix elapsed time format (HH:MM:SS or MM:SS or SS)
 */
function parseElapsedTime(etime) {
  const parts = etime.split(':').map(p => parseInt(p.replace(/-/g, '')));

  if (etime.includes('-')) {
    // Days-HH:MM:SS format
    const [days, rest] = etime.split('-');
    const timeParts = rest.split(':').map(p => parseInt(p));
    const d = parseInt(days);
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
  // Format: YYYYMMDDHHmmss.ffffff
  const year = parseInt(dateStr.substring(0, 4));
  const month = parseInt(dateStr.substring(4, 6)) - 1;
  const day = parseInt(dateStr.substring(6, 8));
  const hour = parseInt(dateStr.substring(8, 10));
  const min = parseInt(dateStr.substring(10, 12));
  const sec = parseInt(dateStr.substring(12, 14));
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
 * Kill a process by PID
 */
export async function killProcess(pid) {
  const platform = process.platform;

  if (platform === 'win32') {
    await execAsync(`taskkill /PID ${pid} /F`);
  } else {
    await execAsync(`kill -9 ${pid}`);
  }

  console.log(`🔪 Killed process ${pid}`);
  return true;
}

/**
 * Get detailed info for a specific process
 */
export async function getProcessInfo(pid) {
  const platform = process.platform;

  if (platform === 'darwin' || platform === 'linux') {
    const cmd = `ps -p ${pid} -o pid,ppid,%cpu,%mem,etime,command`;
    const result = await execAsync(cmd).catch(() => null);
    if (!result) return null;

    const lines = result.stdout.trim().split('\n');
    if (lines.length < 2) return null;

    const parts = lines[1].trim().split(/\s+/);
    return {
      pid: parseInt(parts[0]),
      ppid: parseInt(parts[1]),
      cpu: parseFloat(parts[2]),
      memory: parseFloat(parts[3]),
      runtime: parseElapsedTime(parts[4]),
      command: parts.slice(5).join(' ')
    };
  }

  return null;
}
