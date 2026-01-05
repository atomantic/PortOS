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

/**
 * Initialize auto-fixer event listeners
 */
export function initAutoFixer() {
  errorEvents.on('error', async (error) => {
    if (shouldAutoFix(error)) {
      await createAutoFixTask(error);
    }
  });

  console.log('🔧 Auto-fixer initialized');
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

  // Check for duplicate errors within dedupe window
  const errorKey = `${error.code}-${error.message}`;
  const lastSeen = recentErrors.get(errorKey);
  const now = Date.now();

  if (lastSeen && (now - lastSeen) < ERROR_DEDUPE_WINDOW) {
    console.log(`⏭️ Skipping duplicate error: ${error.code}`);
    return false;
  }

  recentErrors.set(errorKey, now);

  // Clean up old entries
  for (const [key, timestamp] of recentErrors.entries()) {
    if (now - timestamp > ERROR_DEDUPE_WINDOW) {
      recentErrors.delete(key);
    }
  }

  return true;
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
