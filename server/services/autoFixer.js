/**
 * Auto-Fixer Service
 *
 * Handles automatic agent spawning for critical errors
 * Integrates with error handler and CoS task system
 */

import { addTask, isRunning } from './cos.js';
import { errorEvents } from '../lib/errorHandler.js';

// Track recent errors to prevent duplicate auto-fix tasks
const recentErrors = new Map();
const ERROR_DEDUPE_WINDOW = 60000; // 1 minute

// Defer task creation so an in-flight fallback retry (driven by
// promptRunner.js) has a chance to handle the failure first. If
// `noteFallbackHandled(provider, model)` fires within the window we cancel
// the task — the user got a result via fallback and shouldn't see noise in
// their plan. 5s covers the common case where the fallback is a fast API
// (claude-code, codex) responding within seconds; a slower fallback whose
// retry exceeds this window will produce both a result AND an investigation
// task, which is acceptable (the user sees what failed and what recovered).
const TASK_DEFER_MS = 5000;
// Invariant: every path that removes a timer here MUST also delete the
// matching map entry (the setTimeout callback, noteFallbackHandled, and
// _resetAutoFixerForTests all uphold this) — otherwise the map grows
// unbounded across the lifetime of the process.
const deferredTasks = new Map(); // errorKey -> { timer }

// Store pending tasks when CoS is not running (for later pickup)
const pendingAutoFixTasks = [];

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
  const pending = deferredTasks.get(errorKey);
  if (pending) {
    clearTimeout(pending.timer);
    deferredTasks.delete(errorKey);
    recentErrors.delete(errorKey);
    console.log(`✅ Suppressed investigation task: fallback handled failure for ${provider} (${model})`);
    return true;
  }
  return false;
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
  recentErrors.clear();
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
  const errorKey = aiProviderErrorKey(ctx.provider, ctx.model);

  if (isDuplicateError(errorKey)) {
    console.log(`⏭️ Skipping duplicate AI provider error: ${ctx.provider} (${ctx.model})`);
    return;
  }
  if (deferredTasks.has(errorKey)) {
    return;
  }

  console.log(`🤖 AI provider error detected: ${ctx.provider} - run ${ctx.runId} (deferring ${TASK_DEFER_MS}ms for possible fallback retry)`);

  const timer = setTimeout(() => {
    deferredTasks.delete(errorKey);
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

  // Create task in CoS system tasks
  const taskData = {
    description: `Fix critical error: ${error.message}`,
    priority: 'HIGH',
    context,
    approvalRequired: false // Auto-approve for auto-fix tasks
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
