/**
 * Job Gates Service
 *
 * Provides precondition checks ("gates") for autonomous jobs that determine
 * whether an LLM agent actually needs to be spawned. When a gate returns
 * { shouldRun: false }, the job completes successfully without consuming
 * an agent slot or incurring LLM costs.
 *
 * Gate functions are pure async predicates registered by job ID. Each returns:
 *   { shouldRun: boolean, reason: string, context?: object }
 *
 * To add a new gate, register it in the GATES object below.
 */

import { getInboxLogCounts } from './brainStorage.js';

/**
 * Brain Review gate: skip if there are no needs_review inbox items
 * and no active ideas to process.
 */
async function brainReviewGate() {
  const counts = await getInboxLogCounts();
  const needsReview = counts.needs_review || 0;
  const classifying = counts.classifying || 0;

  if (needsReview > 0) {
    return {
      shouldRun: true,
      reason: `${needsReview} inbox item(s) need review`,
      context: { needsReview, classifying }
    };
  }

  // If items are still classifying, wait for them to finish
  if (classifying > 0) {
    return {
      shouldRun: false,
      reason: `${classifying} item(s) still classifying, no items need review yet`,
      context: { needsReview, classifying }
    };
  }

  return {
    shouldRun: false,
    reason: 'No inbox items need review',
    context: { needsReview, classifying }
  };
}

/**
 * Registry of gate functions keyed by job ID.
 * Jobs without a gate entry always run (no precondition).
 */
const GATES = Object.assign(Object.create(null), {
  'job-brain-review': brainReviewGate
});

/**
 * Check whether a job should run by evaluating its gate function.
 * Jobs without a registered gate always pass (shouldRun: true).
 *
 * @param {string} jobId - The job ID to check
 * @returns {Promise<{shouldRun: boolean, reason: string, context?: object}>}
 */
export async function checkJobGate(jobId) {
  const gateFn = GATES[jobId];
  if (!gateFn) {
    return { shouldRun: true, reason: 'No gate configured' };
  }
  return gateFn();
}

/**
 * Check if a job has a gate registered.
 * @param {string} jobId
 * @returns {boolean}
 */
export function hasGate(jobId) {
  return Object.prototype.hasOwnProperty.call(GATES, jobId);
}

/**
 * Get all registered gate IDs (for introspection/UI).
 * @returns {string[]}
 */
export function getRegisteredGates() {
  return Object.keys(GATES);
}

// GATES is not exported to prevent external mutation — use checkJobGate/hasGate/getRegisteredGates instead
