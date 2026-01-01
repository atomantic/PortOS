import { spawn } from 'child_process';
import { logAction } from './history.js';

// Allowlist of safe commands
const ALLOWED_COMMANDS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun',
  'node', 'deno',
  'git', 'gh',
  'pm2',
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc',
  'pwd', 'which', 'echo', 'env',
  'curl', 'wget',
  'docker', 'docker-compose',
  'make', 'cargo', 'go', 'python', 'python3', 'pip', 'pip3',
  'brew'
]);

// Track active commands
const activeCommands = new Map();

/**
 * Execute a shell command with safety checks
 */
export function executeCommand(command, workspacePath, onData, onComplete) {
  const commandId = Date.now().toString(36) + Math.random().toString(36).substr(2);

  // Parse command to check allowlist
  const parts = command.trim().split(/\s+/);
  const baseCommand = parts[0];

  if (!ALLOWED_COMMANDS.has(baseCommand)) {
    const error = `Command '${baseCommand}' is not in the allowlist`;
    onComplete?.({ success: false, error, exitCode: 1 });
    logAction('command', null, command.substring(0, 50), { command, workspacePath }, false, error);
    return null;
  }

  const startTime = Date.now();
  let output = '';

  // Use shell to handle pipes, redirects, etc.
  const child = spawn('sh', ['-c', command], {
    cwd: workspacePath || process.cwd(),
    env: { ...process.env, FORCE_COLOR: '1' }
  });

  activeCommands.set(commandId, child);

  child.stdout.on('data', (data) => {
    const text = data.toString();
    output += text;
    onData?.(text, 'stdout');
  });

  child.stderr.on('data', (data) => {
    const text = data.toString();
    output += text;
    onData?.(text, 'stderr');
  });

  child.on('close', (code) => {
    activeCommands.delete(commandId);
    const runtime = Date.now() - startTime;
    const success = code === 0;

    logAction('command', null, command.substring(0, 50), {
      command,
      workspacePath,
      exitCode: code,
      runtime,
      output: output.substring(0, 10000) // Truncate to prevent huge history
    }, success, success ? null : `Exit code ${code}`);

    onComplete?.({
      success,
      exitCode: code,
      runtime,
      output
    });
  });

  child.on('error', (err) => {
    activeCommands.delete(commandId);
    logAction('command', null, command.substring(0, 50), { command, workspacePath }, false, err.message);
    onComplete?.({
      success: false,
      error: err.message,
      exitCode: 1
    });
  });

  return commandId;
}

/**
 * Stop a running command
 */
export function stopCommand(commandId) {
  const child = activeCommands.get(commandId);
  if (child) {
    child.kill('SIGTERM');
    activeCommands.delete(commandId);
    return true;
  }
  return false;
}

/**
 * Check if a command is active
 */
export function isCommandActive(commandId) {
  return activeCommands.has(commandId);
}

/**
 * Get list of allowed commands
 */
export function getAllowedCommands() {
  return Array.from(ALLOWED_COMMANDS).sort();
}

/**
 * Add a command to the allowlist (runtime only)
 */
export function addAllowedCommand(command) {
  ALLOWED_COMMANDS.add(command);
}

/**
 * Remove a command from the allowlist (runtime only)
 */
export function removeAllowedCommand(command) {
  // Don't allow removing core commands
  const core = ['npm', 'node', 'git', 'pm2'];
  if (core.includes(command)) {
    return false;
  }
  ALLOWED_COMMANDS.delete(command);
  return true;
}
