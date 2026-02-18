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

// Track spawned agents with their full commands (by PID)
const spawnedAgentCommands = new Map();

/**
 * Register a spawned agent's full command (call when spawning)
 */
export function registerSpawnedAgent(pid, data) {
  spawnedAgentCommands.set(pid, {
    fullCommand: data.fullCommand,
    agentId: data.agentId,
    taskId: data.taskId,
    model: data.model,
    workspacePath: data.workspacePath,
    prompt: data.prompt,
    registeredAt: Date.now()
  });
}

/**
 * Unregister a spawned agent (call when process exits)
 */
export function unregisterSpawnedAgent(pid) {
  spawnedAgentCommands.delete(pid);
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
      const spawnedData = spawnedAgentCommands.get(proc.pid);

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
  // Security: Validate pattern to prevent command injection
  const safePattern = validatePattern(pattern);
  if (!safePattern) {
    console.warn(`⚠️ Invalid process pattern rejected: ${pattern}`);
    return [];
  }

  // Security: Pattern is validated above to only contain safe characters
  const cmd = `wmic process where "name like '%${safePattern}%'" get ProcessId,ParentProcessId,PercentProcessorTime,WorkingSetSize,CreationDate,CommandLine /format:csv`;

  const result = await execAsync(cmd).catch(() => ({ stdout: '' }));

  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const processes = [];

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length >= 7) {
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
 * Kill a process by PID.
 * If the process is a CoS-spawned agent, delegates to the CoS killAgent
 * to ensure the task is properly blocked instead of requeued.
 */
export async function killProcess(pid) {
  // Security: Ensure PID is a valid integer to prevent command injection
  const safePid = parseInt(pid, 10);
  if (isNaN(safePid) || safePid <= 0) {
    throw new Error('Invalid PID provided');
  }

  // Check if this PID belongs to a CoS-spawned agent
  const spawnedData = spawnedAgentCommands.get(safePid);
  if (spawnedData?.agentId) {
    console.log(`🔪 PID ${safePid} is CoS agent ${spawnedData.agentId}, delegating to CoS killAgent`);
    const { killAgent } = await import('./subAgentSpawner.js');
    const result = await killAgent(spawnedData.agentId);
    if (result.success) return true;
    // Fall through to raw kill if CoS kill failed (agent may have already exited)
    console.log(`⚠️ CoS killAgent failed for ${spawnedData.agentId}: ${result.error}, falling back to raw kill`);
  }

  const platform = process.platform;

  if (platform === 'win32') {
    await execAsync(`taskkill /PID ${safePid} /F`);
  } else {
    await execAsync(`kill -9 ${safePid}`);
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
