import { spawn } from '../lib/childProcess.js';
import { logAction } from './history.js';
import { ALLOWED_COMMANDS, redactOutput, validateCommand } from '../lib/commandSecurity.js';
import { safeChildProcessEnv } from '../lib/processEnv.js';
import { withSpawnCwdEnv } from '../lib/spawnCwd.js';
import { terminateWithEscalation } from '../lib/bufferedSpawn.js';

// SIGTERM grace before a stopped command is SIGKILLed (#12021).
export const STOP_GRACE_MS = 5000;

// commandId → { child, label, cancelEscalation, stopping, timedOut }. An entry lives
// until the child's `close`/`error` fires, never from a stop request: a
// child that ignores SIGTERM is still running and still ours to escalate.
const activeCommands = new Map();

// Stop an active entry: SIGTERM now, SIGKILL after STOP_GRACE_MS if the child
// is still alive. Idempotent — a second request during the grace window is
// absorbed rather than re-signalling or reporting the command as gone.
// History is best-effort bookkeeping beside the command result: a failed history
// write must not become an unowned rejection from a spawn listener (#12978).
async function logHistory(...args) {
  try {
    await logAction(...args);
  } catch (err) {
    console.error(`❌ Failed to log command history: ${err.message}`);
  }
}

function stopEntry(entry) {
  if (entry.stopping) return;
  entry.stopping = true;
  entry.cancelEscalation = terminateWithEscalation(entry.child, { graceMs: STOP_GRACE_MS, label: entry.label });
}

/**
 * Execute a shell command with safety checks
 *
 * Security measures:
 * 1. Base command must be in allowlist
 * 2. Command cannot contain shell metacharacters that enable injection
 * 3. Command executed via spawn with shell:false where possible
 *
 * `timeoutMs` (optional, default none — the operator watches an interactive
 * run) bounds the run: at the deadline the child is stopped through the same
 * SIGTERM→SIGKILL path as a manual stop and the completion reports `timedOut`.
 */
export function executeCommand(command, workspacePath, onData, onComplete, { timeoutMs = null } = {}) {
  const commandId = Date.now().toString(36) + Math.random().toString(36).substr(2);

  const validation = validateCommand(command);
  if (!validation.valid) {
    const trimmedForLog = (command || '').trim();
    onComplete?.({ success: false, error: validation.error, exitCode: 1 });
    if (trimmedForLog) {
      void logHistory('command', null, trimmedForLog.substring(0, 50), { command: trimmedForLog, workspacePath }, false, validation.error);
    }
    return null;
  }

  const { baseCommand, args } = validation;
  const startTime = Date.now();
  let output = '';
  let settled = false;

  // Security: Use spawn with array of args (shell:false) to prevent shell injection.
  // validateCommand has already rejected shell metacharacters AND parsed quoted args
  // correctly (e.g. 'git commit -m "msg with spaces"' becomes 4 args, not 5).
  // safeChildProcessEnv matches the other spawn sites (ffmpeg, python, media):
  // it strips macOS Malloc* debug noise but intentionally inherits the rest of
  // the parent env — allowlisted commands like gh/git/npm legitimately need
  // PATH/HOME and their auth tokens.
  // Pin PWD to the spawn cwd — see withSpawnCwdEnv (#3193). The allowlist
  // includes AI CLIs, so a command run against an app workspace must not be told
  // it lives in the PortOS checkout.
  const commandCwd = workspacePath || process.cwd();
  const child = spawn(baseCommand, args, {
    cwd: commandCwd,
    env: withSpawnCwdEnv(safeChildProcessEnv({ FORCE_COLOR: '1' }), commandCwd),
    shell: false
  });

  const entry = { child, label: `command '${command.substring(0, 50)}'`, cancelEscalation: null, stopping: false, timedOut: false };
  activeCommands.set(commandId, entry);
  const timeoutTimer = timeoutMs > 0
    ? setTimeout(() => {
      entry.timedOut = true;
      console.warn(`⚠️ ${entry.label} exceeded ${timeoutMs}ms — stopping it`);
      stopEntry(entry);
    }, timeoutMs)
    : null;
  timeoutTimer?.unref?.();
  const settle = () => {
    settled = true;
    clearTimeout(timeoutTimer);
    entry.cancelEscalation?.();
    activeCommands.delete(commandId);
  };

  // Every copy of the output leaves this function redacted (#12019): each
  // streamed chunk on its own, and the accumulated buffer once more at close
  // so a secret split across two chunks is still caught in the persisted and
  // completion copies.
  child.stdout.on('data', (data) => {
    const text = data.toString();
    output += text;
    onData?.(redactOutput(text), 'stdout');
  });

  child.stderr.on('data', (data) => {
    const text = data.toString();
    output += text;
    onData?.(redactOutput(text), 'stderr');
  });

  child.on('close', (code, signal) => {
    if (settled) return;
    settle();
    const runtime = Date.now() - startTime;
    const success = code === 0;
    const redacted = redactOutput(output);
    const error = success ? null
      : entry.timedOut ? `Timed out after ${timeoutMs}ms`
        : entry.stopping ? `Stopped (${signal || `exit code ${code}`})`
          : signal ? `Killed by ${signal}` : `Exit code ${code}`;

    void logHistory('command', null, command.substring(0, 50), {
      command,
      workspacePath,
      exitCode: code,
      signal,
      runtime,
      output: redacted.substring(0, 10000) // Truncate to prevent huge history
    }, success, error);

    onComplete?.({
      success,
      exitCode: code,
      signal,
      runtime,
      output: redacted,
      ...(error ? { error } : {}),
      ...(entry.stopping ? { stopped: true } : {}),
      ...(entry.timedOut ? { timedOut: true } : {}),
    });
  });

  child.on('error', (err) => {
    if (settled) return;
    settle();
    void logHistory('command', null, command.substring(0, 50), { command, workspacePath }, false, err.message);
    onComplete?.({
      success: false,
      error: err.message,
      exitCode: 1
    });
  });

  return commandId;
}

/**
 * Stop a running command: SIGTERM, then SIGKILL after STOP_GRACE_MS if it is
 * still alive. Returns true while the command is ours to stop — including a
 * repeat request during the grace window, which is a no-op rather than
 * "not active" — and false once `close` has retired the entry.
 */
export function stopCommand(commandId) {
  const entry = activeCommands.get(commandId);
  if (!entry) return false;
  stopEntry(entry);
  return true;
}

/**
 * Get list of allowed commands
 */
export function getAllowedCommands() {
  return Array.from(ALLOWED_COMMANDS).sort();
}
