/**
 * Agent TUI Spawning
 *
 * Runs CoS agents inside an interactive PTY-backed shell session. This is for
 * providers whose useful interface is a terminal UI rather than a headless CLI
 * or HTTP API.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { appendFile, readFile, rm } from 'fs/promises';
import * as shellService from './shell.js';
import { emitLog } from './cosEvents.js';
import { appendAgentOutputLines, updateAgent, completeAgent } from './cosAgents.js';
import { registerSpawnedAgent, unregisterSpawnedAgent } from './agents.js';
import { markProviderUsageLimit, markProviderRateLimited } from './providerStatus.js';
import { updateTask } from './cos.js';
import { release } from './executionLanes.js';
import { completeExecution, errorExecution } from './toolStateMachine.js';
import { analyzeAgentFailure, resolveFailedTaskUpdate } from './agentErrorAnalysis.js';
import { completeAgentRun } from './agentRunTracking.js';
import { processAgentCompletion } from './agentCompletion.js';
import { persistSimplifySummaries } from './agentLifecycle.js';
import { activeAgents, userTerminatedAgents } from './agentState.js';
import { PATHS } from '../lib/fileUtils.js';
import { resolveCliModel } from '../lib/providerModels.js';
import { createStreamingAnsiStripper } from '../lib/ansiStrip.js';
import {
  DEFAULT_TUI_PROMPT_DELAY_MS,
  DEFAULT_TUI_IDLE_TIMEOUT_MS,
  READY_POLL_INTERVAL_MS,
  READY_IDLE_THRESHOLD_MS,
  PASTE_MARKER_POLL_MS,
  PASTE_MARKER_PATTERN,
  PASTE_TO_ENTER_MIN_DELAY_MS,
  PASTE_TO_ENTER_FALLBACK_MS,
  PASTE_DEADLINE_MS,
  RAW_BUFFER_CAP,
  RAW_BUFFER_HEADROOM,
  OUTPUT_BUFFER_CAP,
  OUTPUT_BUFFER_HEADROOM,
  inferTuiCommand,
  applyCommandDefaults,
} from '../lib/tuiHandshake.js';

// Agent-specific timing/lifecycle constants (not shared with the one-shot
// runner — agents stay alive much longer and write a sentinel file when done).
const DEFAULT_TUI_MIN_RUNTIME_MS = 15000;
// Debounce window for batching parsed output to disk + state. A chatty TUI can
// emit hundreds of lines/sec; without batching, each line triggers a full
// state load+save (see appendAgentOutput) and a small appendFile, which slows
// the PTY event loop and thrashes the filesystem. 250ms is invisible to the
// live tail but cuts I/O by 1-2 orders of magnitude.
const OUTPUT_FLUSH_INTERVAL_MS = 250;
// Sentinel-file polling. TUI agents write `.agent-done` in their workspace
// when they've finished /simplify + /do:pr (or /do:push) — we poll for it
// here so the agent gets cleanly finalized as soon as the work is done,
// without waiting on the much longer idle timeout fallback.
const DONE_SENTINEL_NAME = '.agent-done';
const DONE_POLL_INTERVAL_MS = 2000;

function shellQuote(value) {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function appendModelArgs(args, model) {
  const effectiveModel = resolveCliModel(model);
  return effectiveModel ? [...args, '--model', effectiveModel] : args;
}

export function buildTuiSpawnConfig(provider, model) {
  const command = provider?.command || inferTuiCommand(provider?.id);
  const baseArgs = applyCommandDefaults(command, [...(provider?.args || [])]);
  const args = appendModelArgs(baseArgs, model);

  return {
    command,
    args,
    commandLine: [command, ...args].map(shellQuote).join(' '),
    promptDelayMs: provider?.tuiPromptDelayMs || DEFAULT_TUI_PROMPT_DELAY_MS,
    idleTimeoutMs: provider?.tuiIdleTimeoutMs || DEFAULT_TUI_IDLE_TIMEOUT_MS
  };
}

export async function spawnTuiAgent(agentId, task, prompt, workspacePath, model, provider, runId, tuiConfig, agentDir, executionId, laneName, { cleanupWorktreeFn, isTruthyMetaFn }) {
  const outputFile = join(agentDir, 'output.txt');
  const cwd = workspacePath && typeof workspacePath === 'string' ? workspacePath : PATHS.root;
  const promptPreview = prompt.replace(/\s+/g, ' ').slice(0, 100);
  const commandName = tuiConfig.command.split('/').pop();

  let outputBuffer = '';
  let rawBuffer = '';
  let finalized = false;
  let hasStartedWorking = false;
  let promptSentAt = null;
  let firstOutputAt = null;
  let lastOutputAt = Date.now();
  let lastLine = '';
  let sessionId = null;

  let pendingLines = [];
  let flushTimer = null;
  let flushing = null;
  let pasteEnterTimer = null;

  const streamingStrip = createStreamingAnsiStripper();

  const flushPendingLines = async () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pendingLines.length === 0) return;
    const batch = pendingLines;
    pendingLines = [];
    await Promise.all([
      appendAgentOutputLines(agentId, batch).catch(() => {}),
      appendFile(outputFile, batch.map(l => `${l}\n`).join('')).catch(() => {})
    ]);
  };

  const scheduleFlush = () => {
    if (flushTimer || flushing) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushing = flushPendingLines().finally(() => { flushing = null; });
    }, OUTPUT_FLUSH_INTERVAL_MS);
  };

  // TUI agents only emit a handful of internal status lines (session-started,
  // prompt-pasted, completion) — see handleData for why per-line capture of
  // the PTY stream itself is intentionally dropped.
  const appendLine = (line) => {
    const cleanLine = line.trim();
    if (!cleanLine || cleanLine === lastLine) return;

    lastLine = cleanLine;
    outputBuffer += `${cleanLine}\n`;
    if (outputBuffer.length > OUTPUT_BUFFER_HEADROOM) {
      outputBuffer = outputBuffer.slice(-OUTPUT_BUFFER_CAP);
    }
    pendingLines.push(cleanLine);
    scheduleFlush();
  };

  const finish = async ({ success, exitCode = 0, error = null, reason = 'completed' }) => {
    if (finalized) return;
    finalized = true;

    const agentData = activeAgents.get(agentId);
    if (agentData?.idleTimer) clearInterval(agentData.idleTimer);
    if (agentData?.promptTimer) clearInterval(agentData.promptTimer);
    if (agentData?.doneSentinelTimer) clearInterval(agentData.doneSentinelTimer);
    if (pasteEnterTimer) { clearInterval(pasteEnterTimer); pasteEnterTimer = null; }

    // Drain pending parsed lines before the final state writes so completion
    // events don't beat the last output batch to disk.
    if (flushing) await flushing.catch(() => {});
    await flushPendingLines();

    const duration = Date.now() - (agentData?.startedAt || Date.now());
    const terminatedByUser = userTerminatedAgents.has(agentId);
    if (terminatedByUser) userTerminatedAgents.delete(agentId);

    const finalSuccess = terminatedByUser ? false : success;
    const finalError = terminatedByUser ? 'Agent terminated by user' : error;

    if (agentData?.laneName || laneName) release(agentId);

    const effectiveExecutionId = agentData?.executionId || executionId;
    if (effectiveExecutionId) {
      if (finalSuccess) {
        completeExecution(effectiveExecutionId, { success: true, duration });
      } else {
        errorExecution(effectiveExecutionId, { message: finalError || `TUI agent ended: ${reason}`, code: exitCode });
        completeExecution(effectiveExecutionId, { success: false });
      }
    }

    // output.txt has already been incrementally appended via flushPendingLines;
    // do NOT writeFile() it from outputBuffer at finalize — outputBuffer is
    // capped at OUTPUT_BUFFER_CAP and would silently truncate the on-disk
    // record for long runs. The append-only stream is the authoritative copy.

    const analysisBuffer = rawBuffer || outputBuffer;
    const errorAnalysis = finalSuccess ? null : analyzeAgentFailure(analysisBuffer, task, model);

    if (finalSuccess) {
      await persistSimplifySummaries(agentId, task, outputBuffer, isTruthyMetaFn);
    }

    await completeAgent(agentId, {
      success: finalSuccess,
      exitCode,
      duration,
      outputLength: outputBuffer.length,
      error: finalError || undefined,
      errorAnalysis,
      completionReason: reason
    });

    await completeAgentRun(runId, outputBuffer, exitCode, duration, errorAnalysis);

    if (terminatedByUser) {
      await updateTask(task.id, {
        status: 'blocked',
        metadata: {
          ...task.metadata,
          blockedReason: 'Terminated by user',
          blockedCategory: 'user-terminated',
          blockedAt: new Date().toISOString()
        }
      }, task.taskType || 'user');
    } else if (finalSuccess) {
      await updateTask(task.id, { status: 'completed' }, task.taskType || 'user');
    } else {
      const failedUpdate = await resolveFailedTaskUpdate(task, errorAnalysis, agentId);
      await updateTask(task.id, failedUpdate, task.taskType || 'user');

      if (errorAnalysis?.category === 'usage-limit' && errorAnalysis.requiresFallback) {
        await markProviderUsageLimit(provider.id, errorAnalysis).catch(err => {
          emitLog('warn', `Failed to mark provider unavailable: ${err.message}`, { providerId: provider.id });
        });
      }
      if (errorAnalysis?.category === 'rate-limit') {
        await markProviderRateLimited(provider.id).catch(err => {
          emitLog('warn', `Failed to mark provider rate limited: ${err.message}`, { providerId: provider.id });
        });
      }
    }

    await processAgentCompletion(agentId, task, finalSuccess, outputBuffer);
    if (workspacePath) await rm(join(workspacePath, DONE_SENTINEL_NAME)).catch(() => {});

    // TUI agents run /do:pr (or /do:push) themselves before signaling via
    // .agent-done, so the system-side cleanup must NOT also push or open a
    // PR — that would double-fire. `skipMerge` is forced on so the
    // post-exit auto-merge doesn't trip over a branch the agent already
    // pushed. The worktree directory itself is still cleaned up.
    await cleanupWorktreeFn(agentId, finalSuccess, {
      openPR: false,
      requestCopilotReview: false,
      skipMerge: true,
      description: task.description,
      agentOutput: outputBuffer,
      originalTask: task
    });

    if (agentData?.pid) unregisterSpawnedAgent(agentData.pid);
    activeAgents.delete(agentId);
    if (sessionId && shellService.getSession(sessionId)) shellService.killSession(sessionId);
  };

  const handleData = async (data) => {
    const text = data.toString();
    rawBuffer += text;
    if (rawBuffer.length > RAW_BUFFER_HEADROOM) rawBuffer = rawBuffer.slice(-RAW_BUFFER_CAP);
    lastOutputAt = Date.now();
    if (firstOutputAt === null) firstOutputAt = lastOutputAt;

    if (!hasStartedWorking) {
      hasStartedWorking = true;
      await updateAgent(agentId, { metadata: { phase: 'working' } });
      emitLog('info', `TUI agent ${agentId} working...`, { agentId, phase: 'working' });
    }

    // The TUI is a *screen*, not a log: every progress tick repaints the
    // status line (`thinking with…`, token counters, footer) and gets
    // re-captured if we parse it line-by-line. The attached shell session
    // shows the live TUI faithfully — see-the-shell is the user-facing
    // path. We still buffer the raw stream into rawBuffer for error
    // analysis on failure, and we detect early "command not found" so a
    // missing binary fails fast instead of idling.
    if (!promptSentAt) {
      const lowerStripped = streamingStrip(text).toLowerCase();
      if (lowerStripped.includes('command not found') && lowerStripped.includes(commandName.toLowerCase())) {
        await finish({
          success: false,
          exitCode: 127,
          error: `TUI command not found: ${tuiConfig.command}`,
          reason: 'command-not-found'
        });
      }
    }
  };

  const handleExit = async ({ exitCode, killed }) => {
    if (finalized) return;
    const code = typeof exitCode === 'number' ? exitCode : killed ? 130 : 0;
    await finish({
      success: code === 0 && !killed,
      exitCode: code,
      error: killed ? 'TUI shell session was killed' : null,
      reason: killed ? 'shell-killed' : 'shell-exit'
    });
  };

  sessionId = shellService.createShellSession(null, {
    cwd,
    kind: 'agent-tui',
    agentId,
    label: `${provider.name} ${agentId}`,
    command: tuiConfig.commandLine,
    initialCommand: tuiConfig.commandLine,
    env: provider.envVars || {},
    onData: handleData,
    onExit: handleExit
  });

  if (!sessionId) {
    await finish({ success: false, exitCode: 1, error: 'Failed to create TUI shell session', reason: 'spawn-error' });
    return null;
  }

  const ptyProcess = shellService.getSessionProcess(sessionId);
  const pid = ptyProcess?.pid || null;
  if (pid) {
    registerSpawnedAgent(pid, {
      fullCommand: tuiConfig.commandLine,
      agentId,
      taskId: task.id,
      model,
      workspacePath,
      prompt: (task.description || '').substring(0, 500)
    });
  }

  // Send the bracketed-paste prompt only after the TUI has finished its initial
  // repaint and gone quiet — pasting during the banner/loading screen is the
  // failure mode that left the input empty. The `\r` is split from the paste
  // write because a fixed delay races Claude Code's paste-commit on large
  // prompts; instead we poll Claude Code's raw output for its
  // `[Pasted text #N +M lines]` marker, then wait an extra
  // PASTE_TO_ENTER_MIN_DELAY_MS before submitting. A fallback timer fires
  // the Enter unconditionally if the marker never appears (very small
  // prompts won't trigger the marker). All timers are tracked so finish()
  // can cancel pending writes if the agent ends mid-handshake.
  const startedAt = Date.now();
  const sendPrompt = (reason) => {
    if (finalized || promptSentAt) return;
    promptSentAt = Date.now();
    const rawBufferLenBeforePaste = rawBuffer.length;
    shellService.writeToSession(sessionId, `\x1b[200~${prompt}\x1b[201~`);
    appendLine(`📟 Prompt pasted into TUI session ${sessionId.slice(0, 8)} (${reason})`);

    const submitEnter = () => {
      if (finalized) return;
      shellService.writeToSession(sessionId, '\r');
    };

    const pasteSentAt = Date.now();
    pasteEnterTimer = setInterval(() => {
      if (finalized) {
        clearInterval(pasteEnterTimer);
        pasteEnterTimer = null;
        return;
      }
      const elapsed = Date.now() - pasteSentAt;
      const postPasteOutput = rawBuffer.slice(rawBufferLenBeforePaste);
      const markerSeen = PASTE_MARKER_PATTERN.test(postPasteOutput);
      // Submit when EITHER the paste-commit marker appears (preferred) or
      // the fallback window elapses (covers small prompts that don't render
      // the marker).
      if ((markerSeen && elapsed >= PASTE_TO_ENTER_MIN_DELAY_MS)
        || elapsed >= PASTE_TO_ENTER_FALLBACK_MS) {
        clearInterval(pasteEnterTimer);
        pasteEnterTimer = null;
        submitEnter();
      }
    }, PASTE_MARKER_POLL_MS);
  };

  const promptTimer = setInterval(() => {
    if (finalized || promptSentAt) {
      clearInterval(promptTimer);
      return;
    }
    const now = Date.now();
    const elapsed = now - startedAt;
    if (elapsed >= PASTE_DEADLINE_MS) {
      sendPrompt('fallback');
      clearInterval(promptTimer);
      return;
    }
    if (elapsed < tuiConfig.promptDelayMs) return;
    if (firstOutputAt === null) return;
    if (now - lastOutputAt < READY_IDLE_THRESHOLD_MS) return;
    sendPrompt('ready');
    clearInterval(promptTimer);
  }, READY_POLL_INTERVAL_MS);

  const idleTimer = setInterval(() => {
    if (!promptSentAt || finalized) return;
    const runtime = Date.now() - promptSentAt;
    const idle = Date.now() - lastOutputAt;
    if (runtime < DEFAULT_TUI_MIN_RUNTIME_MS) return;
    // We track post-paste activity via lastOutputAt instead of parsed-line
    // counts because per-line PTY capture is intentionally disabled for TUI
    // agents — see handleData.
    if (lastOutputAt <= promptSentAt) return;
    if (idle >= tuiConfig.idleTimeoutMs) {
      finish({ success: true, exitCode: 0, reason: 'idle-complete' }).catch(err => {
        emitLog('error', `Failed to finalize TUI agent ${agentId}: ${err.message}`, { agentId });
      });
    }
  }, 5000);

  // Sentinel-file watcher. The agent's prompt instructs it to write
  // .agent-done in the workspace after running /simplify + /do:pr; the file
  // contains a markdown task summary that we ingest line-by-line into the
  // agent's outputBuffer so downstream code (extractFinalSummary,
  // persistSimplifySummaries, completion hooks, the agent card) gets the
  // same `outputBuffer.tail = summary` shape it used to get from headless
  // CLI runs. Idle-complete is just the fallback for an agent that didn't
  // comply.
  const doneSentinelPath = workspacePath ? join(workspacePath, DONE_SENTINEL_NAME) : null;
  const doneSentinelTimer = doneSentinelPath ? setInterval(() => {
    if (finalized) return;
    if (!existsSync(doneSentinelPath)) return;
    clearInterval(doneSentinelTimer);
    readFile(doneSentinelPath, 'utf8')
      .then(contents => {
        const trimmed = contents.trim();
        if (!trimmed) return;
        appendLine(`✅ Agent signaled completion`);
        // Cap at 4 KB so a runaway agent that pasted the entire diff into
        // the sentinel doesn't blow up the agent record / downstream
        // memory-extraction prompts.
        const truncated = trimmed.length > 4096 ? `${trimmed.slice(0, 4096)}\n…[truncated]` : trimmed;
        for (const line of truncated.split('\n')) appendLine(line);
      })
      .catch(() => {})
      .finally(() => {
        finish({ success: true, exitCode: 0, reason: 'agent-signaled-done' }).catch(err => {
          emitLog('error', `Failed to finalize TUI agent ${agentId} after sentinel: ${err.message}`, { agentId });
        });
      });
  }, DONE_POLL_INTERVAL_MS) : null;

  activeAgents.set(agentId, {
    process: ptyProcess || { kill: () => shellService.killSession(sessionId) },
    taskId: task.id,
    startedAt: Date.now(),
    runId,
    pid,
    providerId: provider.id,
    executionId,
    laneName,
    tuiSessionId: sessionId,
    idleTimer,
    promptTimer,
    doneSentinelTimer
  });

  // Identify which TUI binary this session is running so consumers can gate
  // features that aren't universal — e.g. only Claude Code supports
  // bracketed-paste injection of post-spawn BTW messages; codex/gemini/lm-studio
  // TUIs don't.
  const tuiKind = commandName.toLowerCase();
  await updateAgent(agentId, {
    pid,
    metadata: {
      phase: 'working',
      executionMode: 'tui',
      tuiSessionId: sessionId,
      tuiCommand: tuiConfig.commandLine,
      tuiKind,
      tuiIdleTimeoutMs: tuiConfig.idleTimeoutMs
    }
  });

  appendLine(`📟 TUI session started: ${sessionId.slice(0, 8)} (${tuiConfig.commandLine})`);
  appendLine(`💡 Open the Shell tab for live TUI output — this panel only logs lifecycle events.`);
  return agentId;
}
