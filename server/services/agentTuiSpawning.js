/**
 * Agent TUI Spawning
 *
 * Runs CoS agents inside an interactive PTY-backed shell session. This is for
 * providers whose useful interface is a terminal UI rather than a headless CLI
 * or HTTP API.
 */

import { join } from 'path';
import { appendFile, rm } from 'fs/promises';
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

const DEFAULT_TUI_PROMPT_DELAY_MS = 2500;
const DEFAULT_TUI_IDLE_TIMEOUT_MS = 180000;
const DEFAULT_TUI_MIN_RUNTIME_MS = 15000;
const RAW_BUFFER_CAP = 512 * 1024;
const RAW_BUFFER_HEADROOM = 640 * 1024;
const OUTPUT_BUFFER_CAP = 1024 * 1024;
const OUTPUT_BUFFER_HEADROOM = 1280 * 1024;
// Debounce window for batching parsed output to disk + state. A chatty TUI can
// emit hundreds of lines/sec; without batching, each line triggers a full
// state load+save (see appendAgentOutput) and a small appendFile, which slows
// the PTY event loop and thrashes the filesystem. 250ms is invisible to the
// live tail but cuts I/O by 1-2 orders of magnitude.
const OUTPUT_FLUSH_INTERVAL_MS = 250;

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

function stripAnsi(text) {
  return text
    .replace(ANSI_PATTERN, '')
    .replace(/\x00/g, '')
    .replace(/\u001b/g, '');
}

function shellQuote(value) {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function appendModelArgs(args, model) {
  const effectiveModel = resolveCliModel(model);
  return effectiveModel ? [...args, '--model', effectiveModel] : args;
}

function inferTuiCommand(id) {
  if (!id) return 'claude';
  if (id.includes('codex')) return 'codex';
  if (id.includes('gemini')) return 'gemini';
  return 'claude';
}

export function buildTuiSpawnConfig(provider, model) {
  const command = provider?.command || inferTuiCommand(provider?.id);
  const baseArgs = [...(provider?.args || [])];
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
  let lastOutputAt = Date.now();
  let meaningfulLinesAfterPrompt = 0;
  let lastLine = '';
  let sessionId = null;

  let pendingLines = [];
  let flushTimer = null;
  let flushing = null;

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

  const appendLine = (line) => {
    const cleanLine = line.trim();
    if (!cleanLine || cleanLine === lastLine) return;
    if (promptPreview && cleanLine.replace(/\s+/g, ' ').includes(promptPreview)) return;

    lastLine = cleanLine;
    outputBuffer += `${cleanLine}\n`;
    if (outputBuffer.length > OUTPUT_BUFFER_HEADROOM) {
      outputBuffer = outputBuffer.slice(-OUTPUT_BUFFER_CAP);
    }
    pendingLines.push(cleanLine);
    scheduleFlush();
    if (promptSentAt) meaningfulLinesAfterPrompt++;
  };

  const finish = async ({ success, exitCode = 0, error = null, reason = 'completed' }) => {
    if (finalized) return;
    finalized = true;

    const agentData = activeAgents.get(agentId);
    if (agentData?.idleTimer) clearInterval(agentData.idleTimer);
    if (agentData?.promptTimer) clearTimeout(agentData.promptTimer);

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
    if (workspacePath) await rm(join(workspacePath, 'BTW.md')).catch(() => {});

    const directOpenPR = isTruthyMetaFn(task.metadata?.openPR);
    const directReviewLoopFollowUp = isTruthyMetaFn(task.metadata?.reviewLoopFollowUp);
    await cleanupWorktreeFn(agentId, finalSuccess, {
      openPR: directOpenPR,
      requestCopilotReview: directOpenPR && isTruthyMetaFn(task.metadata?.reviewLoop),
      skipMerge: directReviewLoopFollowUp,
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

    if (!hasStartedWorking) {
      hasStartedWorking = true;
      await updateAgent(agentId, { metadata: { phase: 'working' } });
      emitLog('info', `TUI agent ${agentId} working...`, { agentId, phase: 'working' });
    }

    const clean = stripAnsi(text).replace(/\r/g, '\n');
    const lowerClean = clean.toLowerCase();
    if (!promptSentAt && lowerClean.includes('command not found') && lowerClean.includes(commandName.toLowerCase())) {
      await finish({
        success: false,
        exitCode: 127,
        error: `TUI command not found: ${tuiConfig.command}`,
        reason: 'command-not-found'
      });
      return;
    }

    const lines = clean.split('\n').map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      appendLine(line);
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

  const promptTimer = setTimeout(() => {
    if (finalized) return;
    promptSentAt = Date.now();
    shellService.writeToSession(sessionId, `\x1b[200~${prompt}\x1b[201~\r`);
    appendLine(`📟 Prompt pasted into TUI session ${sessionId.slice(0, 8)}`);
  }, tuiConfig.promptDelayMs);

  const idleTimer = setInterval(() => {
    if (!promptSentAt || finalized) return;
    const runtime = Date.now() - promptSentAt;
    const idle = Date.now() - lastOutputAt;
    if (runtime < DEFAULT_TUI_MIN_RUNTIME_MS) return;
    if (meaningfulLinesAfterPrompt < 2) return;
    if (idle >= tuiConfig.idleTimeoutMs) {
      finish({ success: true, exitCode: 0, reason: 'idle-complete' }).catch(err => {
        emitLog('error', `Failed to finalize TUI agent ${agentId}: ${err.message}`, { agentId });
      });
    }
  }, 5000);

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
    promptTimer
  });

  await updateAgent(agentId, {
    pid,
    metadata: {
      phase: 'working',
      executionMode: 'tui',
      tuiSessionId: sessionId,
      tuiCommand: tuiConfig.commandLine,
      tuiIdleTimeoutMs: tuiConfig.idleTimeoutMs
    }
  });

  appendLine(`📟 TUI session started: ${sessionId.slice(0, 8)} (${tuiConfig.commandLine})`);
  return agentId;
}
