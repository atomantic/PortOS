import { spawn } from 'child_process';
import { logAction } from './history.js';
import { ALLOWED_COMMANDS, validateCommand } from '../lib/commandSecurity.js';

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

  const validation = validateCommand(command);
  if (!validation.valid) {
    const trimmedForLog = (command || '').trim();
    onComplete?.({ success: false, error: validation.error, exitCode: 1 });
    if (trimmedForLog) {
      logAction('command', null, trimmedForLog.substring(0, 50), { command: trimmedForLog, workspacePath }, false, validation.error);
    }
    return null;
  }

  const { baseCommand, args } = validation;
  const startTime = Date.now();
  let output = '';

  // Security: Use spawn with array of args (shell:false) to prevent shell injection.
  // validateCommand has already rejected shell metacharacters AND parsed quoted args
  // correctly (e.g. 'git commit -m "msg with spaces"' becomes 4 args, not 5).
  const child = spawn(baseCommand, args, {
    cwd: workspacePath || process.cwd(),
    env: { ...process.env, FORCE_COLOR: '1' },
    shell: false,
    windowsHide: true
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

