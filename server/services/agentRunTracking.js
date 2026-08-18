/**
 * Agent Run Tracking
 *
 * Handles creation, completion, and run-level usage recording for CoS agent runs.
 */

import { join } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { recordSession } from './usage.js';
import { recordCompletedRunUsage } from './usageReconciler.js';
import { committedDuringRun } from '../lib/gitCommitProbe.js';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { appendRunEvent } from './agentRunEventLog.js';

const RUNS_DIR = PATHS.runs;

/**
 * Create a run entry for usage tracking.
 *
 * @param {object} options
 * @param {string} options.agentId
 * @param {{ id: string, description?: string }} options.task
 * @param {string} [options.model] - Falls back to the provider's default model.
 * @param {{ id: string, name: string, defaultModel?: string }} options.provider
 * @param {string} options.workspacePath
 * @param {string} [options.appName] - Defaults to 'portos'.
 */
export async function createAgentRun({ agentId, task, model, provider, workspacePath, appName }) {
  const runId = uuidv4();
  const runDir = join(RUNS_DIR, runId);

  // ensureDir is idempotent (mkdir recursive) — no existence pre-check needed.
  await ensureDir(RUNS_DIR);
  await mkdir(runDir);

  const metadata = {
    id: runId,
    type: 'ai',
    source: 'cos-agent',
    agentId,
    taskId: task.id,
    providerId: provider.id,
    providerName: provider.name,
    model: model || provider.defaultModel,
    workspacePath,
    workspaceName: appName || 'portos',
    prompt: (task.description || '').substring(0, 500),
    // Full prompt size (chars) for input-token estimation on completion —
    // `prompt` above is truncated for display.
    promptLength: (task.description || '').length,
    startTime: new Date().toISOString(),
    endTime: null,
    duration: null,
    exitCode: null,
    success: null,
    error: null,
    outputSize: 0
  };

  await atomicWrite(join(runDir, 'metadata.json'), metadata);
  await writeFile(join(runDir, 'prompt.txt'), task.description || '');
  await writeFile(join(runDir, 'output.txt'), '');

  // Record usage session for CoS agent
  recordSession(provider.id, provider.name, model || provider.defaultModel).catch(err => {
    console.error(`❌ Failed to record usage session: ${err.message}`);
  });

  // Open the run's entry in the append-only lifecycle ledger (#4540). Additive:
  // `metadata.json` above remains the durable run record; this is the ordered
  // trace that survives the in-place updates. Deliberately NOT given the task
  // description — the ledger redacts prompts, so passing one would only produce
  // a `{ redacted }` stub. `appendRunEvent` never rejects.
  await appendRunEvent({
    kind: 'run.spawned',
    runId,
    agentId,
    taskId: task.id,
    at: metadata.startTime,
    data: {
      providerId: provider.id,
      model: metadata.model,
      workspacePath,
      workspaceName: metadata.workspaceName,
      promptChars: metadata.promptLength
    }
  });

  return { runId, runDir };
}

/**
 * Complete a run entry with final results.
 *
 * `successOverride` (#3358) lets finalizeAgent record a run that exited 0 but
 * failed its PR-claim verification as the failure it is. Without it the run
 * history would keep saying "success" for exactly the run the agent record and
 * the task status now agree did NOT land its deliverable.
 */
export async function completeAgentRun(runId, output, exitCode, duration, errorAnalysis = null, successOverride = null) {
  if (!runId) return; // Skip if no runId (e.g., agent recovered after restart)

  const runDir = join(RUNS_DIR, runId);
  const metaPath = join(runDir, 'metadata.json');

  const metadata = await readJSONFile(metaPath, null);
  if (!metadata) return;
  if (metadata.endTime) return;

  metadata.endTime = new Date().toISOString();
  metadata.duration = duration;
  metadata.exitCode = exitCode;

  // Post-execution validation: a non-zero exit that nonetheless left a commit
  // behind DID the work (#3637 — the probe is the run window, not a marker in
  // the commit subject, because nothing ever emitted such a marker). The window
  // opens at the run's own startTime, so commits another agent pushed before
  // this run began don't launder it into a success.
  let success = exitCode === 0;
  const runStartedAt = Date.parse(metadata.startTime);
  if (!success && metadata.taskId && metadata.workspacePath) {
    if (await committedDuringRun(metadata.workspacePath, runStartedAt)) {
      console.log(`⚠️ Agent ${metadata.agentId} reported failure (exit ${exitCode}) but work completed - commit found for task ${metadata.taskId}`);
      success = true;
    }
  }
  // An explicit false from the caller is authoritative and outranks both the
  // exit code and the commit rescue above; null (the default) means "no opinion".
  if (successOverride === false) success = false;

  metadata.success = success;
  metadata.outputSize = Buffer.byteLength(output || '');

  // Store error details - extract from output if no analysis provided. A clean
  // exit that was overridden to failure (#3358) also needs its diagnostic
  // recorded, or the run reads `success: false` with nothing saying why.
  if (exitCode !== 0 || !success) {
    const errorInfo = errorAnalysis || extractErrorFromOutput(output, exitCode);
    metadata.error = errorInfo.message || `Process exited with code ${exitCode}`;
    metadata.errorDetails = errorInfo.details || metadata.error;
    metadata.errorCategory = errorInfo.category || 'unknown';
    metadata.suggestedFix = errorInfo.suggestedFix || null;
    if (errorInfo.compaction) {
      metadata.compaction = errorInfo.compaction;
    }
  }

  // Persist output first so endTime remains the durable completion marker. If
  // this write fails, the still-open metadata lets recovery retry the whole
  // operation; once metadata lands, every run artifact is already complete.
  await writeFile(join(runDir, 'output.txt'), output || '');
  await atomicWrite(metaPath, metadata);

  // Record usage for every completed CoS agent run: failed and interrupted
  // providers still consumed tokens. Prefers the provider CLI's own
  // per-message token counts (read from its on-disk transcript, including the
  // prompt-cache tiers) and falls back to the prompt-length/stdout estimate.
  // `metadata` already carries the endTime stamped above, which bounds the
  // transcript window. Owns its own error handling.
  if (metadata.providerId && metadata.model) {
    recordCompletedRunUsage(metadata, output);
  }

  // Close the run's ledger entry (#4540). This is the terminal event for every
  // exit path — clean exits, spawn errors, and the orphan sweep all land here —
  // so `projectRunStates` can trust `run.finalized` to outrank an earlier
  // `run.orphan-recovered`. The verdict recorded is the RESOLVED one (after the
  // commit rescue and the `successOverride`), not the raw exit code, because
  // that is the verdict the run record now carries.
  await appendRunEvent({
    kind: 'run.finalized',
    runId,
    agentId: metadata.agentId,
    taskId: metadata.taskId,
    at: metadata.endTime,
    data: {
      success,
      exitCode,
      durationMs: Number.isFinite(duration) ? duration : null,
      outputBytes: metadata.outputSize,
      errorCategory: metadata.errorCategory ?? null,
      successOverridden: successOverride === false
    }
  });
}

/**
 * Extract error information from output when no pattern matches.
 */
export function extractErrorFromOutput(output, exitCode) {
  if (!output || output.trim().length === 0) {
    // Map common exit codes to readable messages
    const exitCodeMessages = {
      1: 'General error',
      2: 'Misuse of shell command',
      126: 'Command invoked cannot execute (permission or not executable)',
      127: 'Command not found',
      128: 'Invalid exit argument',
      130: 'Script terminated by Ctrl+C',
      137: 'Process killed (SIGKILL)',
      143: 'Process terminated (SIGTERM - likely timeout)',
      255: 'Exit status out of range'
    };
    const codeMsg = exitCodeMessages[exitCode] || `Unknown error`;
    return {
      message: `${codeMsg} (exit code ${exitCode})`,
      details: `Process exited with code ${exitCode}. No output was captured.`,
      category: exitCode === 143 ? 'timeout' : 'unknown'
    };
  }

  const lines = output.split('\n').filter(l => l.trim());
  const lastLines = lines.slice(-20);

  // Look for common error patterns
  const errorPatterns = [
    { pattern: /API Error:\s*(\d+)/i, category: 'api-error' },
    { pattern: /error[:\s]+(.+)/i, category: 'error' },
    { pattern: /failed[:\s]+(.+)/i, category: 'failure' },
    { pattern: /exception[:\s]+(.+)/i, category: 'exception' },
    { pattern: /fatal[:\s]+(.+)/i, category: 'fatal' },
    { pattern: /not found/i, category: 'not-found' },
    { pattern: /permission denied/i, category: 'permission' },
    { pattern: /connection refused/i, category: 'connection' },
    { pattern: /timeout/i, category: 'timeout' },
    { pattern: /rate limit/i, category: 'rate-limit' },
    { pattern: /invalid.*key/i, category: 'auth' },
    { pattern: /unauthorized/i, category: 'auth' },
    { pattern: /authentication failed/i, category: 'auth' }
  ];

  const matchedErrors = [];
  let category = 'unknown';
  for (const line of lastLines) {
    for (const { pattern, category: cat } of errorPatterns) {
      if (pattern.test(line)) {
        matchedErrors.push(line.trim());
        if (category === 'unknown') category = cat;
        break;
      }
    }
  }

  // Use matched errors or fallback to last lines
  const errorLines = matchedErrors.length > 0
    ? matchedErrors.slice(0, 5)
    : lastLines.slice(-5);

  return {
    message: errorLines[0] || `Process exited with code ${exitCode}`,
    details: errorLines.join('\n') || `Process exited with code ${exitCode}`,
    category
  };
}
