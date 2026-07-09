/**
 * Auto-Fixer Service
 *
 * Handles automatic agent spawning for critical errors
 * Integrates with error handler and CoS task system
 */

import { addTask, isRunning } from './cos.js';
import { errorEvents } from '../lib/errorHandler.js';
import { ERROR_CATEGORIES } from '../lib/aiToolkit/errorDetection.js';

// Track recent errors to prevent duplicate auto-fix tasks
const recentErrors = new Map();
const ERROR_DEDUPE_WINDOW = 60000; // 1 minute

// Defer task creation as a backstop for the case where NO fallback is
// attempted (e.g. no fallback configured) — the timer fires and the
// investigation task is created. When a fallback IS attempted, promptRunner.js
// drives the lifecycle explicitly (noteFallbackStarted → noteFallbackHandled /
// noteFallbackFailed), which is authoritative regardless of how long the
// fallback takes. The fixed timer alone was a bug: a slow CLI fallback (Claude
// Code can take 20–30s) outran the window, so a successfully-recovered failure
// still left an investigation task in the user's plan.
const TASK_DEFER_MS = 5000;
// Invariant: every path that removes a timer here MUST also delete the
// matching map entry (the setTimeout callback, noteFallbackHandled, and
// _resetAutoFixerForTests all uphold this) — otherwise the map grows
// unbounded across the lifetime of the process.
const deferredTasks = new Map(); // errorKey -> { timer }
// Error keys whose failure is currently being retried via a fallback. While a
// key is in this set, the backstop timer is suppressed (we wait for the
// fallback's real outcome). Cleared by noteFallbackHandled (success → no task)
// and noteFallbackFailed (failure → the fallback's own task already covers it).
const inFlightFallbacks = new Set(); // errorKey

// Circuit breaker: if the SAME resource (errorKey) trips auto-fix more than
// CIRCUIT_MAX_FAILURES times within CIRCUIT_WINDOW_MS, stop creating
// investigation/fix tasks for it. A resource failing this persistently won't be
// healed by yet another identical task — repeating only exhausts the plan queue
// and can drive an unbounded retry loop. The window is rolling: timestamps older
// than CIRCUIT_WINDOW_MS are pruned on every check, so the circuit auto-closes
// once the failure rate ages out (no manual reset needed).
const CIRCUIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const CIRCUIT_MAX_FAILURES = 3;
const failureTimestamps = new Map(); // errorKey -> number[] (ms timestamps, newest-last)

// Record a task-worthy failure for `errorKey` and report whether the circuit is
// now OPEN — i.e. this failure is the (CIRCUIT_MAX_FAILURES + 1)th within the
// rolling window and the caller should SUPPRESS task creation. Only genuinely
// new failures (past the dedupe + in-flight-fallback guards) should reach here,
// so the count reflects distinct recovery attempts, not log spam.
function tripCircuit(errorKey) {
  const now = Date.now();

  // Sweep fully-aged keys so the map can't grow unbounded — `error.message`
  // (part of the generic errorKey) can carry dynamic text, so distinct keys
  // accumulate over the process lifetime otherwise. Mirrors isDuplicateError's
  // global cleanup of recentErrors.
  for (const [key, stamps] of failureTimestamps.entries()) {
    if (stamps.every((t) => now - t >= CIRCUIT_WINDOW_MS)) {
      failureTimestamps.delete(key);
    }
  }

  const recent = (failureTimestamps.get(errorKey) || []).filter((t) => now - t < CIRCUIT_WINDOW_MS);
  recent.push(now);
  failureTimestamps.set(errorKey, recent);
  return recent.length > CIRCUIT_MAX_FAILURES;
}

// Store pending tasks when CoS is not running (for later pickup)
const pendingAutoFixTasks = [];

// Collapse a (possibly multi-line) error string to one capped line for logging
// — the single-line logging convention forbids multi-line blobs; the untruncated
// text always remains in the run record's `error` field.
const oneLine = (s, max = 300) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function aiProviderErrorKey(providerName, model) {
  // NUL separator: provider names ("Claude Code CLI") and model ids
  // ("gpt-4o-mini") both commonly contain `-`, so a `-`-joined key would
  // collide for pairs like ("gpt-4o", "mini") vs ("gpt", "4o-mini") and
  // silently dedupe distinct failures together. NUL never appears in
  // legitimate provider/model identifiers, so the key is unambiguous.
  return `AI_PROVIDER_EXECUTION_FAILED\x00${providerName}\x00${model}`;
}

/**
 * Cancel a deferred investigation task for `provider`/`model` because a
 * fallback retry succeeded. Called from `runPromptThroughProvider` after
 * a successful fallback — the user got their result, so the queued task
 * would be noise. Also clears the dedupe entry so a *future* failure of
 * the same provider can still raise a task (otherwise the dedupe window
 * would silently suppress real failures for up to 60s).
 *
 * `provider` matches `ctx.provider` (the provider's display name, not id)
 * because that's what the failure event payload uses — see the
 * `onRunFailed` hook in server/index.js.
 */
export function noteFallbackHandled({ provider, model }) {
  const errorKey = aiProviderErrorKey(provider, model);
  inFlightFallbacks.delete(errorKey);
  const pending = deferredTasks.get(errorKey);
  if (pending) {
    clearTimeout(pending.timer);
    deferredTasks.delete(errorKey);
    console.log(`✅ Suppressed investigation task: fallback handled failure for ${provider} (${model})`);
  }
  // Always clear the dedupe entry — whether or not there was a timer to cancel
  // (noteFallbackStarted may have already cancelled it) — so a *future*
  // identical failure can still raise a task.
  recentErrors.delete(errorKey);
  return !!pending;
}

/**
 * Mark that promptRunner is about to retry `provider`/`model` via a fallback.
 * Cancels the deferred investigation task immediately and suppresses any that
 * would otherwise be scheduled (handleAIProviderError checks the in-flight set),
 * so a slow fallback that exceeds TASK_DEFER_MS can't leave a task behind. The
 * fallback's eventual outcome (noteFallbackHandled / noteFallbackFailed) clears
 * the in-flight marker.
 */
export function noteFallbackStarted({ provider, model }) {
  const errorKey = aiProviderErrorKey(provider, model);
  inFlightFallbacks.add(errorKey);
  const pending = deferredTasks.get(errorKey);
  if (pending) {
    clearTimeout(pending.timer);
    deferredTasks.delete(errorKey);
  }
}

/**
 * Mark that the fallback retry for `provider`/`model` ALSO failed. Releases the
 * in-flight suppression without creating a task for the primary: the fallback
 * provider's own failure already queued its investigation task, so one task per
 * user action is enough. Also clears the dedupe entry so a later retry isn't
 * silently suppressed.
 */
export function noteFallbackFailed({ provider, model }) {
  const errorKey = aiProviderErrorKey(provider, model);
  inFlightFallbacks.delete(errorKey);
  recentErrors.delete(errorKey);
}

/**
 * Check if an error is a duplicate within the dedupe window
 * Also cleans up expired entries
 * @returns {boolean} true if this is a duplicate error
 */
function isDuplicateError(errorKey) {
  const now = Date.now();
  const lastSeen = recentErrors.get(errorKey);

  // Clean up expired entries
  for (const [key, timestamp] of recentErrors.entries()) {
    if (now - timestamp > ERROR_DEDUPE_WINDOW) {
      recentErrors.delete(key);
    }
  }

  if (lastSeen && (now - lastSeen) < ERROR_DEDUPE_WINDOW) {
    return true;
  }

  recentErrors.set(errorKey, now);
  return false;
}

let autoFixerInitialized = false;

/**
 * Initialize auto-fixer event listeners
 */
export function initAutoFixer() {
  if (autoFixerInitialized) return;
  autoFixerInitialized = true;

  errorEvents.on('error', (error) => {
    (async () => {
      // Always handle AI provider errors (even if CoS not running)
      if (error.code === 'AI_PROVIDER_EXECUTION_FAILED') {
        await handleAIProviderError(error);
        return;
      }

      if (shouldAutoFix(error)) {
        await createAutoFixTask(error);
      }
    })().catch(err => console.error(`❌ autoFixer handler failed: ${err.message}`));
  });

  console.log('🔧 Auto-fixer initialized');
}

/**
 * Get pending autofix tasks (for CoS to pick up when it starts)
 */
export function getPendingAutoFixTasks() {
  return [...pendingAutoFixTasks];
}

/**
 * Clear pending autofix tasks after they've been processed
 */
export function clearPendingAutoFixTasks() {
  pendingAutoFixTasks.length = 0;
}

/**
 * Test-only: drop all deferred timers + dedupe entries so the next call
 * starts from a clean slate. Production code paths never call this.
 */
export function _resetAutoFixerForTests() {
  for (const { timer } of deferredTasks.values()) clearTimeout(timer);
  deferredTasks.clear();
  inFlightFallbacks.clear();
  recentErrors.clear();
  failureTimestamps.clear();
  pendingAutoFixTasks.length = 0;
}

/**
 * Defer task creation by TASK_DEFER_MS. If `noteFallbackHandled` is called
 * for the same provider/model within the window, the timer is cancelled
 * and no task is created. Otherwise, the deferred handler runs and
 * creates the investigation task.
 */
async function handleAIProviderError(error) {
  const ctx = error.context || {};

  // A content/safety refusal is not a provider fault — we know exactly why it
  // failed (the model declined the prompt), so there's nothing for a CoS agent
  // to investigate. promptRunner.js already retries with a fallback and the UI
  // is told what happened. Bail before deferring/creating a task. (server's
  // onRunFailed already emits a distinct code for refusals so this handler
  // normally isn't even reached; this guard covers any other emitter.)
  if (ctx.errorAnalysis?.category === ERROR_CATEGORIES.CONTENT_REFUSAL) {
    console.log(`🛟 AI model refused prompt on content/safety grounds: ${ctx.provider} (${ctx.model}) — no investigation task (fallback handles it)`);
    return;
  }

  const errorKey = aiProviderErrorKey(ctx.provider, ctx.model);

  // A fallback retry for this exact failure is already in flight (promptRunner
  // called noteFallbackStarted). Don't schedule the backstop timer — the
  // fallback's outcome decides whether to investigate. This covers the case
  // where the fallback started before this handler ran (microtask ordering).
  if (inFlightFallbacks.has(errorKey)) {
    return;
  }

  if (isDuplicateError(errorKey)) {
    console.log(`⏭️ Skipping duplicate AI provider error: ${ctx.provider} (${ctx.model})`);
    return;
  }
  if (deferredTasks.has(errorKey)) {
    return;
  }

  // Surface the actual failure reason + category inline so pm2 logs explain
  // WHY a run failed without spelunking into data/runs/<id>/metadata.json. The
  // reason is collapsed to a single line and capped (logging convention: no
  // multi-line blobs) — the full text stays in the run record's `error` field.
  const reason = oneLine(ctx.errorDetails || ctx.errorAnalysis?.message) || 'no error text captured';
  const category = ctx.errorAnalysis?.category || 'unknown';
  console.log(`🤖 AI provider error detected: ${ctx.provider} (${ctx.model}) [${category}] exit=${ctx.exitCode ?? '?'} - run ${ctx.runId}: ${reason} (deferring ${TASK_DEFER_MS}ms for possible fallback retry)`);

  const timer = setTimeout(() => {
    deferredTasks.delete(errorKey);
    // Circuit breaker: only count a failure that actually survives the defer
    // window (a fallback that recovered the failure has already cancelled this
    // timer, so it never reaches here). A provider/model that keeps producing
    // real investigation tasks this often won't be fixed by yet another — trip
    // the circuit and suppress. Auto-closes once failures age out of the window.
    if (tripCircuit(errorKey)) {
      console.log(`🔌 Auto-fix circuit OPEN for ${ctx.provider} (${ctx.model}) — >${CIRCUIT_MAX_FAILURES} failures within the last hour; suppressing investigation task`);
      return;
    }
    createAIProviderInvestigationTask(error).catch(err => {
      console.error(`❌ Deferred AI provider task creation failed: ${err.message}`);
      // Clear the dedupe entry so the next identical failure isn't
      // silently suppressed for up to 60s — without this, an addTask
      // failure here would block legitimate retries that might succeed.
      recentErrors.delete(errorKey);
    });
  }, TASK_DEFER_MS);
  // Keep the timer from preventing process exit (e.g. in tests / shutdown).
  timer.unref?.();
  deferredTasks.set(errorKey, { timer });
}

async function createAIProviderInvestigationTask(error) {
  const ctx = error.context || {};
  // Build specialized context for AI provider errors
  const context = buildAIProviderErrorContext(error);

  const taskData = {
    description: `Investigate AI provider failure: ${ctx.provider} (${ctx.model})`,
    priority: 'MEDIUM',
    context,
    app: 'portos', // Associate with PortOS app
    approvalRequired: true // Require user approval before investigating
  };

  // If CoS is running, create the task immediately
  if (isRunning()) {
    const task = await addTask(taskData, 'internal');
    console.log(`✅ AI provider investigation task created: ${task.id}`);
    return task;
  }

  // Otherwise, store for later pickup
  console.log(`📋 CoS not running - queuing AI provider investigation task`);
  pendingAutoFixTasks.push({
    ...taskData,
    createdAt: Date.now(),
    error: {
      code: error.code,
      message: error.message,
      context: ctx
    }
  });

  return null;
}

/**
 * Determine if an error should trigger auto-fix
 */
function shouldAutoFix(error) {
  // Only auto-fix if CoS is running
  if (!isRunning()) {
    return false;
  }

  // Only auto-fix critical errors or those explicitly marked as auto-fixable
  if (error.severity !== 'critical' && !error.canAutoFix) {
    return false;
  }

  const errorKey = `${error.code}-${error.message}`;

  if (isDuplicateError(errorKey)) {
    console.log(`⏭️ Skipping duplicate error: ${error.code}`);
    return false;
  }

  // Circuit breaker: the same critical error recurring past the threshold won't
  // be resolved by spawning another identical fix task — suppress to prevent a
  // runaway loop. Auto-closes once the failure rate ages out of the window.
  if (tripCircuit(errorKey)) {
    console.log(`🔌 Auto-fix circuit OPEN for ${error.code} — >${CIRCUIT_MAX_FAILURES} failures within the last hour; suppressing auto-fix task`);
    return false;
  }

  return true;
}

/**
 * Build detailed context for AI provider execution errors
 */
function buildAIProviderErrorContext(error) {
  const ctx = error.context || {};
  const lines = [
    '# AI Provider Execution Failure',
    '',
    '## Run Details',
    `- **Run ID:** ${ctx.runId || 'N/A'}`,
    `- **Provider:** ${ctx.provider || 'Unknown'}`,
    `- **Provider ID:** ${ctx.providerId || 'N/A'}`,
    `- **Model:** ${ctx.model || 'N/A'}`,
    `- **Exit Code:** ${ctx.exitCode ?? 'N/A'}`,
    `- **Duration:** ${ctx.duration ? `${(ctx.duration / 1000).toFixed(1)}s` : 'N/A'}`,
    `- **Workspace:** ${ctx.workspaceName || ctx.workspacePath || 'N/A'}`,
    ''
  ];

  // Add error category if available
  if (ctx.errorCategory) {
    lines.push(`## Error Category: ${ctx.errorCategory}`);
    if (ctx.suggestedFix) {
      lines.push(`**Suggested Fix:** ${ctx.suggestedFix}`);
    }
    lines.push('');
  }

  // Add error details
  lines.push('## Error Details');
  if (ctx.errorDetails) {
    lines.push('```');
    lines.push(ctx.errorDetails);
    lines.push('```');
  } else {
    lines.push(error.message || 'No error details available');
  }
  lines.push('');

  // Add prompt preview if available
  if (ctx.promptPreview) {
    lines.push('## Prompt Preview');
    lines.push('```');
    lines.push(ctx.promptPreview);
    lines.push('```');
    lines.push('');
  }

  // Add output tail if available (last part of output for debugging)
  if (ctx.outputTail) {
    lines.push('## Output Tail (last 2KB)');
    lines.push('```');
    lines.push(ctx.outputTail);
    lines.push('```');
    lines.push('');
  }

  lines.push('## Investigation Steps');
  lines.push('1. Check if the AI provider is configured correctly in /devtools/providers');
  lines.push('2. Verify API keys and endpoints are valid');
  lines.push('3. Check server logs for additional context (pm2 logs portos-server)');
  lines.push('4. If this is a CLI provider, verify the command is installed and accessible');
  lines.push('5. Check for rate limiting or quota issues with the provider');
  lines.push('6. Review the output tail for specific error messages');

  return lines.join('\n');
}

/**
 * Create a CoS task to fix the error
 */
async function createAutoFixTask(error) {
  console.log(`🤖 Creating auto-fix task for error: ${error.code}`);

  // Build context for the agent
  const context = buildErrorContext(error);

  // Create task in CoS system tasks. Requires approval, matching every other
  // error-driven task creator in this file — a crash alone isn't enough
  // signal to let an agent edit code unsupervised.
  const taskData = {
    description: `Fix critical error: ${error.message}`,
    priority: 'HIGH',
    context,
    approvalRequired: true
  };

  const task = await addTask(taskData, 'internal');
  console.log(`✅ Auto-fix task created: ${task.id}`);

  return task;
}

/**
 * Build detailed context for the auto-fix agent
 */
function buildErrorContext(error) {
  const lines = [
    '# Error Details',
    '',
    `**Error Code:** ${error.code}`,
    `**Severity:** ${error.severity}`,
    `**Timestamp:** ${new Date(error.timestamp).toISOString()}`,
    '',
    '## Error Message',
    error.message,
    ''
  ];

  // Add stack trace if available
  if (error.stack) {
    lines.push('## Stack Trace');
    lines.push('```');
    lines.push(error.stack);
    lines.push('```');
    lines.push('');
  }

  // Add context if available
  if (error.context && Object.keys(error.context).length > 0) {
    lines.push('## Context');
    for (const [key, value] of Object.entries(error.context)) {
      lines.push(`- **${key}:** ${JSON.stringify(value)}`);
    }
    lines.push('');
  }

  lines.push('## Instructions');
  lines.push('1. Analyze the error and identify the root cause');
  lines.push('2. Check server logs and browser console for additional context');
  lines.push('3. Fix the issue in the codebase');
  lines.push('4. Verify the fix works by testing the affected functionality');
  lines.push('5. If you cannot fix the issue, document your findings in a comment');

  return lines.join('\n');
}

/**
 * Handle manual error recovery request from UI
 */
export async function handleErrorRecovery(errorCode, context) {
  console.log(`🔧 Manual error recovery requested: ${errorCode}`);

  const taskData = {
    description: `Investigate and fix error: ${errorCode}`,
    priority: 'MEDIUM',
    context: context || `User requested investigation of error code: ${errorCode}`,
    approvalRequired: true // Manual recovery requires approval
  };

  const task = await addTask(taskData, 'internal');
  console.log(`✅ Recovery task created: ${task.id}`);

  return task;
}
