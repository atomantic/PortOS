/** Spawn and register a one-shot PTY, retaining an early exit until its completion handlers are installed. */
import { spawn as ptySpawn } from 'node-pty';
import { buildCliChildEnv } from '../../lib/cliChildEnv.js';
import { findCommandOnPath } from '../../lib/processEnv.js';
import { resolveSplashHarnessContext } from '../../lib/splashHarnessLaunch.js';
import { runChildIdentity } from '../../lib/aiToolkit/internal/runOwnership.js';
import { processGroupKillable } from '../../lib/credentialBootstrap.js';
import { killProcessTree } from '../../lib/bufferedSpawn.js';
import { isHostShuttingDown } from '../../lib/hostShutdown.js';
import { patchRunMetadata, registerActiveRun, emitRunStarted, consumeRunStopRequested, failRunRecord, finalizeRunRecord } from '../runner.js';
import { registerExternalSession } from '../shell.js';

// Wide PTY so TUI doesn't wrap responses at narrow widths, which makes
// downstream parsing harder.
const PTY_COLS = 200;
const PTY_ROWS = 50;

export async function runTuiSession(options, invocation, maintenanceLifecycle, watchSession) {
  const { runId, guard = false, onData, onComplete, reportFailure = true, beforeExecute } = options;
  const { provider, spawnCommand, workingDir, runIdentity } = invocation;
  // Direct PTY execution needs an explicit PWD and terminal capabilities in the provider environment.
  const childEnv = buildCliChildEnv({
    provider: await resolveSplashHarnessContext(provider, provider.defaultModel),
    cwd: workingDir,
    guard,
    extra: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });

  // execvp can fail without any PTY output. Probe the child PATH and report the conventional 127 error.
  if (!findCommandOnPath(spawnCommand, { env: childEnv, cwd: workingDir })) {
    return failRunRecord({
      runId,
      error: `TUI command not found: ${spawnCommand}`,
      exitCode: 127,
      startTime: Date.now(),
      onData,
      onComplete,
      identity: runIdentity,
      reportFailure,
    });
  }

  if (beforeExecute) {
    try { await beforeExecute(); }
    catch (error) {
      await finalizeRunRecord({ runId, output: '', exitCode: 1, success: false, error: error.message, startTime: Date.now(),
        extras: { canceled: true, completionReason: 'canceled' }, identity: runIdentity });
      throw error;
    }
  }

  // Keep spawn, early-exit capture and data listener registration in the same turn.
  const session = openTuiSession(options, invocation, childEnv, maintenanceLifecycle);
  return watchSession(options, invocation, session);
}

function openTuiSession({ runId, label, onReady }, invocation, childEnv, maintenanceLifecycle) {
  const { provider, command, args, spawnCommand, spawnArgs, processGroup, workingDir } = invocation;
  let ptyProcess;
  try {
    ptyProcess = ptySpawn(spawnCommand, spawnArgs, {
      name: 'xterm-256color',
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: workingDir,
      env: childEnv,
    });
  } catch (err) {
    throw new Error(`Failed to spawn TUI '${spawnCommand}': ${err.message}`);
  }

  // node-pty never replays an early exit. Subscribe before registering the session and drain it once all handlers exist.
  maintenanceLifecycle.spawned = true;
  let dispatchPtyExit = null;
  let pendingPtyExit = null;
  ptyProcess.onExit((event) => {
    maintenanceLifecycle.exited = true;
    maintenanceLifecycle.settle();
    if (dispatchPtyExit) {
      dispatchPtyExit(event);
      return;
    }
    pendingPtyExit = pendingPtyExit || event;
  });

  const childIdentitySaved = patchRunMetadata(runId, { executionChild: runChildIdentity(ptyProcess.pid) });

  // The Stop action must signal the process group when a credential wrapper owns the PTY.
  registerActiveRun(runId, processGroupKillable(ptyProcess, processGroup));

  // Publish the run only after the PTY is available to Stop.
  emitRunStarted({ runId, provider, model: provider.defaultModel });

  // Register for viewing after direct spawn to avoid the interactive shell session cap and login shell.
  const viewLabel = (typeof label === 'string' && label)
    ? label
    : `${command} · ${provider.defaultModel || 'tui'}`;
  registerExternalSession(runId, ptyProcess, {
    label: viewLabel,
    command: `${command} ${args.join(' ')}`.trim(),
    cwd: workingDir,
    kind: 'tui-run',
  });
  try {
    onReady?.({
      runId,
      providerId: provider.id,
      providerName: provider.name || provider.id,
      model: provider.defaultModel,
      providerType: provider.type,
      shellReady: true,
    });
  } catch (err) {
    console.error(`❌ TUI ready hook failed: ${err.message}`);
  }

  return {
    ptyProcess,
    childIdentitySaved,
    // forkpty gives a credential bootstrap wrapper and its harness a shared process group.
    killPty: () => { if (!ptyProcess.killed) killProcessTree(ptyProcess, 'SIGHUP', { processGroup }); },
    onExit(handlePtyExit) {
      dispatchPtyExit = handlePtyExit;
      if (pendingPtyExit) {
        const earlyExit = pendingPtyExit;
        pendingPtyExit = null;
        handlePtyExit(earlyExit);
      }
    },
  };
}

export function finishTuiExit({ runId, state, finish, detectTerminalRequestTimeout, finishWithFallbackSignal }, { exitCode, signal }) {
  const killed = !!signal;
  // Shutdown and explicit Stop are intentional interruptions and must never trigger provider fallback.
  const stopRequested = consumeRunStopRequested(runId);
  const hostInterrupted = killed && isHostShuttingDown();
  // The explicit stop marker survives a CLI handling SIGTERM and returning a normal exit code.
  const canceled = stopRequested || hostInterrupted;
  const finalExitCode = typeof exitCode === 'number' ? exitCode : (killed ? 130 : 0);
  const success = !canceled && !killed && finalExitCode === 0;
  // A clean exit terminates a partial timeout banner. There can be no further retry repaint.
  const heldTimeout = success ? detectTerminalRequestTimeout(null, { endOfStream: true }) : null;
  if (heldTimeout) {
    finishWithFallbackSignal(heldTimeout, { processExited: true }).catch((err) => {
      console.error(`❌ TUI run ${runId} exit-time timeout handling failed: ${err?.message || err}`);
    });
    return;
  }
  // Keep nonzero exits actionable even when the provider supplied no structured error.
  let error = null;
  if (hostInterrupted) {
    error = `TUI interrupted by PortOS shutdown (signal ${signal})`;
  } else if (stopRequested) {
    error = killed ? `TUI canceled (signal ${signal})` : `TUI canceled (exit code ${finalExitCode})`;
  } else if (killed) {
    error = `TUI killed (signal ${signal})`;
  } else if (!success) {
    const tail = state.outputBuffer.slice(-200).trim();
    error = tail
      ? `TUI exited with code ${finalExitCode}: ${tail}`
      : `TUI exited with code ${finalExitCode}`;
  }
  finish({
    success,
    exitCode: finalExitCode,
    error,
    reason: hostInterrupted ? 'host-shutdown' : (stopRequested ? 'canceled' : (killed ? 'killed' : 'exit')),
    canceled,
  });
}
