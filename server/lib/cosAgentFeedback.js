/**
 * Shared CoS feedback eligibility rules.
 *
 * The queue, pending-feedback store, server submission boundary, and Agents
 * tab must agree on exactly which completed runs can receive a human rating.
 * Keep this module pure so the client can re-export the same predicates.
 */

import { isAgentHandoff } from './agentOutcome.js';

export const FEEDBACK_RATINGS = Object.freeze(['positive', 'negative', 'neutral']);

const FEEDBACK_RATING_SET = new Set(FEEDBACK_RATINGS);
const DATE_BUCKET_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isFeedbackRating(value) {
  return FEEDBACK_RATING_SET.has(value);
}

export function hasValidAgentFeedback(agent) {
  return isFeedbackRating(agent?.feedback?.rating);
}

export function isSystemAgent(agent) {
  return agent?.taskId?.startsWith('sys-') || agent?.id?.startsWith('sys-');
}

export function isManualUserAgent(agent) {
  return agent?.metadata?.taskType === 'user';
}

/** True when a completed record is a valid target, even if already rated. */
export function isAgentFeedbackTarget(agent) {
  return agent?.status === 'completed'
    && !isSystemAgent(agent)
    && isManualUserAgent(agent)
    && !isAgentHandoff(agent);
}

/** True only for an unrated completed manual user run. */
export function isAgentFeedbackEligible(agent) {
  return isAgentFeedbackTarget(agent) && !hasValidAgentFeedback(agent);
}

/**
 * A legacy handoff may already carry a rating from before handoffs left the
 * feedback queue. Keep that existing card editable without making an unrated
 * handoff actionable again.
 */
export function isAgentFeedbackUpdateTarget(agent) {
  return isAgentFeedbackTarget(agent) || (
    isAgentHandoff(agent)
    && hasValidAgentFeedback(agent)
    && !isSystemAgent(agent)
    && isManualUserAgent(agent)
  );
}

/** Return the archive locator encoded by a completed record, if valid. */
export function feedbackArchiveDate(agent) {
  const date = typeof agent?.completedAt === 'string' ? agent.completedAt.slice(0, 10) : null;
  return DATE_BUCKET_PATTERN.test(date || '') ? date : null;
}
