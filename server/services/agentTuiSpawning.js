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

// Paste readiness gating. The TUI process needs time to render its welcome
// banner and become input-ready before bracketed paste lands; sending the paste
// during boot loses the entire prompt. We poll for output-idle (TUI has stopped
// repainting) instead of guessing a fixed delay, with a hard upper bound so a
// silent provider still gets the prompt eventually.
const READY_POLL_INTERVAL_MS = 300;
const READY_IDLE_THRESHOLD_MS = 1200;
const PASTE_TO_ENTER_DELAY_MS = 400;
const PASTE_DEADLINE_MS = 10000;

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

// Heuristics for a trailing chunk that *might* be an unterminated escape
// sequence. We hold the tail back from the strip pass and prepend it to the
// next chunk, so a CSI/OSC split across two PTY reads still strips cleanly
// instead of leaking the body (e.g. `0;Claude Code…`) into displayed output.
const INCOMPLETE_CSI = /^\x1B\[[0-?]*[ -/]*$/;
const INCOMPLETE_OSC = /^\x1B\][^\x07\x1B]*$/;
const INCOMPLETE_ESC_2BYTE = /^\x1B$/;

function createStreamingAnsiStripper() {
  let tail = '';
  const strip = (s) => s.replace(ANSI_PATTERN, '').replace(/\x00/g, '');
  return (text) => {
    const combined = tail + text;
    tail = '';
    const lastEsc = combined.lastIndexOf('\x1B');
    // Only consider the trailing fragment if it lives near the end — older
    // unterminated bytes belong to a previous repaint and would never resolve.
    // Bodies longer than 4096 bytes are treated as terminated; an unbounded
    // OSC (e.g. very long hyperlink) would leak its body to display rather
    // than buffer forever.
    if (lastEsc !== -1 && combined.length - lastEsc <= 4096) {
      const candidate = combined.slice(lastEsc);
      if (INCOMPLETE_ESC_2BYTE.test(candidate)
        || INCOMPLETE_CSI.test(candidate)
        || INCOMPLETE_OSC.test(candidate)) {
        tail = candidate;
        return strip(combined.slice(0, lastEsc));
      }
    }
    return strip(combined);
  };
}

// TUI repaint artifacts that aren't useful to display in the agent output
// panel. The raw PTY stream still goes to the attached shell session (and to
// rawBuffer for error analysis) — this only suppresses display noise.
const BOX_DRAW_CHARS = /[─│┌┐└┘├┤┬┴┼━┃╮╯╰╭╱╲╳▶◀▼▲╴╵╶╷▌▐▖▗▘▝▙▚▛▜▟►◄·•]/g;
const STATUS_FOOTER_PATTERNS = [
  /bypass permissions (on|off)/i,
  /shift\s*\+\s*tab to cycle/i
];

export function isTuiNoise(line) {
  if (!line) return true;
  const stripped = line.replace(BOX_DRAW_CHARS, '').trim();
  if (!stripped) return true;
  // Single bullet/prompt marker with nothing else
  if (/^[>?]\s*$/.test(stripped)) return true;
  // "Try 'how does X work?'" placeholder
  if (/^try ["'].*["']\??$/i.test(stripped)) return true;
  // Welcome banner lines (Claude Code v…, Opus 4.x, etc.)
  if (/^claude code\b/i.test(stripped) && stripped.length < 64) return true;
  if (/^opus \d/i.test(stripped) && stripped.length < 64) return true;
  // Status footer / help bar
  if (STATUS_FOOTER_PATTERNS.some(re => re.test(stripped))) return true;
  // Letter-spaced gibberish from TUI animation: e.g. "c l a u d e - c o d e".
  // Match strings where the majority of whitespace-separated tokens are a
  // single character — the TUI sometimes renders typed input one glyph at a
  // time with separating spaces during paste/erase animation.
  if (stripped.length > 8) {
    const tokens = stripped.split(/\s+/);
    if (tokens.length >= 6) {
      const singleCharTokens = tokens.filter(t => t.length === 1).length;
      if (singleCharTokens >= tokens.length * 0.6) return true;
    }
  }
  return false;
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
  let firstOutputAt = null;
  let lastOutputAt = Date.now();
  let meaningfulLinesAfterPrompt = 0;
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

  const appendLine = (line, { force = false } = {}) => {
    const cleanLine = line.trim();
    if (!cleanLine || cleanLine === lastLine) return;
    if (promptPreview && cleanLine.replace(/\s+/g, ' ').includes(promptPreview)) return;
    // Filter TUI repaint artifacts (banners, status footer, box drawing,
    // letter-spaced animation frames). `force: true` lets internal messages
    // ("TUI session started", etc.) bypass the filter.
    if (!force && isTuiNoise(cleanLine)) return;

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
    if (agentData?.promptTimer) clearInterval(agentData.promptTimer);
    if (pasteEnterTimer) { clearTimeout(pasteEnterTimer); pasteEnterTimer = null; }

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
    if (firstOutputAt === null) firstOutputAt = lastOutputAt;

    if (!hasStartedWorking) {
      hasStartedWorking = true;
      await updateAgent(agentId, { metadata: { phase: 'working' } });
      emitLog('info', `TUI agent ${agentId} working...`, { agentId, phase: 'working' });
    }

    const clean = streamingStrip(text).replace(/\r/g, '\n');
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

  // Send the bracketed-paste prompt only after the TUI has finished its initial
  // repaint and gone quiet — pasting during the banner/loading screen is the
  // failure mode that left the input empty. The `\r` is split from the paste
  // write so Claude Code has time to commit the paste buffer before Enter
  // fires; its handle is tracked so finish() can cancel a still-pending Enter
  // if the agent ends in that window.
  const startedAt = Date.now();
  const sendPrompt = (reason) => {
    if (finalized || promptSentAt) return;
    promptSentAt = Date.now();
    shellService.writeToSession(sessionId, `\x1b[200~${prompt}\x1b[201~`);
    pasteEnterTimer = setTimeout(() => {
      pasteEnterTimer = null;
      if (finalized) return;
      shellService.writeToSession(sessionId, '\r');
    }, PASTE_TO_ENTER_DELAY_MS);
    appendLine(`📟 Prompt pasted into TUI session ${sessionId.slice(0, 8)} (${reason})`, { force: true });
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

  appendLine(`📟 TUI session started: ${sessionId.slice(0, 8)} (${tuiConfig.commandLine})`, { force: true });
  return agentId;
}
