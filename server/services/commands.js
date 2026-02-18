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

// Shell metacharacters that could be used for command injection
// Security: Reject any command containing these to prevent injection via pipes, chaining, etc.
const DANGEROUS_SHELL_CHARS = /[;|&`$(){}[\]<>\\!#*?~]/;

// Track active commands
const activeCommands = new Map();

/**
 * Execute a shell command with safety checks
 *
 * Security measures:
 * 1. Base command must be in allowlist
 * 2. Command cannot contain shell metacharacters that enable injection
 * 3. Command executed via spawn with shell:false where possible
 */
export function executeCommand(command, workspacePath, onData, onComplete) {
  const commandId = Date.now().toString(36) + Math.random().toString(36).substr(2);

  // Security: Reject empty or whitespace-only commands
  const trimmedCommand = command?.trim();
  if (!trimmedCommand) {
    const error = 'Empty command provided';
    onComplete?.({ success: false, error, exitCode: 1 });
    return null;
  }

  // Parse command to check allowlist
  const parts = trimmedCommand.split(/\s+/);
  const baseCommand = parts[0];

  if (!ALLOWED_COMMANDS.has(baseCommand)) {
    const error = `Command '${baseCommand}' is not in the allowlist`;
    onComplete?.({ success: false, error, exitCode: 1 });
    logAction('command', null, trimmedCommand.substring(0, 50), { command: trimmedCommand, workspacePath }, false, error);
    return null;
  }

  // Security: Check for dangerous shell metacharacters that could enable command injection
  // This prevents attacks like: npm; rm -rf / or npm && malicious_cmd or npm | cat /etc/passwd
  if (DANGEROUS_SHELL_CHARS.test(trimmedCommand)) {
    const error = 'Command contains disallowed shell characters (security restriction)';
    onComplete?.({ success: false, error, exitCode: 1 });
    logAction('command', null, trimmedCommand.substring(0, 50), { command: trimmedCommand, workspacePath }, false, error);
    return null;
  }

  const startTime = Date.now();
  let output = '';

  // Security: Use spawn with array of args (shell:false) to prevent shell injection
  // The DANGEROUS_SHELL_CHARS check above ensures no metacharacters slip through
  const child = spawn(baseCommand, parts.slice(1), {
    cwd: workspacePath || process.cwd(),
    env: { ...process.env, FORCE_COLOR: '1' },
    shell: false
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

