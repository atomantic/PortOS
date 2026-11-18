import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_RATINGS,
  feedbackArchiveDate,
  hasValidAgentFeedback,
  isAgentFeedbackEligible,
  isAgentFeedbackTarget,
  isAgentFeedbackUpdateTarget,
  isFeedbackRating,
} from './cosAgentFeedback.js';

const completedManual = {
  id: 'agent-example',
  status: 'completed',
  completedAt: '2026-08-01T10:00:00.000Z',
  metadata: { taskType: 'user' },
};

describe('CoS feedback eligibility contract', () => {
  it('accepts only the three source-owned ratings', () => {
    expect(FEEDBACK_RATINGS).toEqual(['positive', 'negative', 'neutral']);
    expect(FEEDBACK_RATINGS.every(isFeedbackRating)).toBe(true);
    expect(isFeedbackRating('helpful')).toBe(false);
    expect(isFeedbackRating(null)).toBe(false);
  });

  it.each([
    ['completed manual run', completedManual, true, true, true],
    ['already rated run', { ...completedManual, feedback: { rating: 'positive' } }, true, false, true],
    ['running run', { ...completedManual, status: 'running' }, false, false, false],
    ['scheduled run', { ...completedManual, metadata: { taskType: 'internal' } }, false, false, false],
    ['system id', { ...completedManual, id: 'sys-health' }, false, false, false],
    ['system task', { ...completedManual, taskId: 'sys-health' }, false, false, false],
    ['unrated handoff run', { ...completedManual, result: { resumed: true } }, false, false, false],
    ['already rated handoff run', { ...completedManual, result: { resumed: true }, feedback: { rating: 'positive' } }, false, false, true],
    ['already rated system handoff', { ...completedManual, id: 'sys-health', result: { resumed: true }, feedback: { rating: 'positive' } }, false, false, false],
  ])('classifies %s', (_label, agent, target, eligible, updateTarget) => {
    expect(isAgentFeedbackTarget(agent)).toBe(target);
    expect(isAgentFeedbackEligible(agent)).toBe(eligible);
    expect(isAgentFeedbackUpdateTarget(agent)).toBe(updateTarget);
  });

  it('distinguishes valid feedback from an absent or malformed rating', () => {
    expect(hasValidAgentFeedback({ feedback: { rating: 'neutral' } })).toBe(true);
    expect(hasValidAgentFeedback({ feedback: { rating: '' } })).toBe(false);
    expect(hasValidAgentFeedback({ feedback: { rating: 'yes' } })).toBe(false);
    expect(hasValidAgentFeedback({})).toBe(false);
  });

  it('uses only a valid completion date as the archive locator', () => {
    expect(feedbackArchiveDate(completedManual)).toBe('2026-08-01');
    expect(feedbackArchiveDate({ ...completedManual, completedAt: 'not-a-date' })).toBe(null);
    expect(feedbackArchiveDate({ ...completedManual, completedAt: null })).toBe(null);
  });
});
