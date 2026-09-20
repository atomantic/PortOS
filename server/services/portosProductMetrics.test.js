import { describe, it, expect } from 'vitest';
import {
  summarizePostEngagement,
  summarizeCreativeFeedback,
  buildProductActions,
  toProductMetricsAggregate,
} from './portosProductMetrics.js';

const timezone = 'UTC';
const today = '2026-08-24';

describe('summarizePostEngagement', () => {
  it('combines scored and training activity without losing feature-specific counts', () => {
    const result = summarizePostEngagement({
      timezone,
      today,
      sessions: [{ startedAt: '2026-08-23T12:00:00.000Z', date: '2026-08-23' }],
      trainingEntries: [{ timestamp: '2026-08-22T12:00:00.000Z', date: '2026-08-22' }],
    });

    expect(result).toMatchObject({
      status: 'ok',
      completedToday: false,
      lastActiveDate: '2026-08-23',
      daysSinceActivity: 1,
      currentStreak: 2,
      activeDaysLast7: 2,
      scoredSessionsLast7: 1,
      trainingEntriesLast7: 1,
    });
  });

  it('counts training as today activity and returns an explicit invalid-day sentinel', () => {
    expect(summarizePostEngagement({ timezone, today, sessions: [], trainingEntries: [
      { date: today, timestamp: `${today}T08:00:00.000Z` },
    ] }).completedToday).toBe(true);
    expect(summarizePostEngagement({ timezone, today: null })).toEqual({
      status: 'unavailable',
      reason: 'missing-local-day',
    });
  });
});

describe('summarizeCreativeFeedback', () => {
  it('counts only completed successful projects and leaves unrated renders actionable', () => {
    const result = summarizeCreativeFeedback({
      now: new Date(`${today}T12:00:00.000Z`),
      commissions: [{
        id: 'commission-example',
        name: 'Example Nightly Commission',
        runs: [
          { id: 'run-old', projectId: 'project-old', ranAt: '2026-08-20T02:00:00.000Z', status: 'started' },
          { id: 'run-rated', projectId: 'project-rated', ranAt: '2026-08-23T02:00:00.000Z', status: 'started' },
          { id: 'run-future', projectId: 'project-future', ranAt: '2026-08-25T02:00:00.000Z', status: 'started' },
          { id: 'run-failed', projectId: 'project-failed', ranAt: '2026-08-22T02:00:00.000Z', status: 'failed' },
          { id: 'run-active', projectId: 'project-active', ranAt: '2026-08-21T02:00:00.000Z', status: 'started' },
        ],
        feedback: [{ runId: 'run-rated', rating: 'up', at: '2026-08-23T10:00:00.000Z' }],
      }],
      projects: [
        { id: 'project-old', status: 'complete' },
        { id: 'project-rated', status: 'complete' },
        { id: 'project-future', status: 'complete' },
        { id: 'project-failed', status: 'complete' },
        { id: 'project-active', status: 'rendering' },
      ],
    });

    expect(result).toMatchObject({
      status: 'ok',
      configuredCount: 1,
      completedRenders: 2,
      reviewedRenders: 1,
      unreviewedRenders: 1,
      oldestUnreviewedAgeDays: 4,
      feedbackCoveragePercent: 50,
    });
    expect(result.pendingReviews[0]).toMatchObject({
      commissionId: 'commission-example',
      runId: 'run-old',
      commissionName: 'Example Nightly Commission',
    });
  });

  it('keeps every pending run addressable instead of truncating the compatibility metrics', () => {
    const runs = Array.from({ length: 9 }, (_, index) => ({
      id: `run-${index}`,
      projectId: `project-${index}`,
      ranAt: `2026-08-${String(10 + index).padStart(2, '0')}T12:00:00.000Z`,
      status: 'started',
    }));
    const result = summarizeCreativeFeedback({
      now: new Date(`${today}T12:00:00.000Z`),
      commissions: [{ id: 'commission-example', runs, feedback: [] }],
      projects: runs.map((run) => ({ id: run.projectId, status: 'complete' })),
    });

    expect(result.unreviewedRenders).toBe(9);
    expect(result.pendingReviews).toHaveLength(9);
    expect(result.pendingReviews.at(-1).runId).toBe('run-8');
  });
});

describe('buildProductActions', () => {
  it('creates deep-linked POST and feedback actions from current gaps', () => {
    const actions = buildProductActions({
      post: {
        status: 'ok', completedToday: false, daysSinceActivity: 3,
        activeDaysLast7: 2, currentStreak: 1, today,
      },
      creativeCommissions: {
        status: 'ok', unreviewedRenders: 1, oldestUnreviewedAgeDays: 4,
        feedbackCoveragePercent: 0,
        pendingReviews: [{ commissionId: 'commission-example', commissionName: 'Example', runId: 'run-old' }],
      },
    });

    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      type: 'post_engagement',
      severity: 'high',
      link: '/post/launcher',
      featureId: 'post',
      featureLabel: 'POST',
      required: false,
      isRecommendation: true,
      occurrence: today,
    });
    expect(actions[1]).toMatchObject({
      type: 'commission_feedback',
      severity: 'high',
      link: '/creative-commission/commission-example?run=run-old',
    });
    expect(actions[1].detail).toContain('awaiting review');
    expect(actions[1].detail).not.toContain('awaitsing');
  });

  it('creates one optional feedback action per pending run with stable occurrence identity', () => {
    const actions = buildProductActions({
      post: { status: 'ok', completedToday: true, today },
      creativeCommissions: {
        status: 'ok',
        unreviewedRenders: 2,
        oldestUnreviewedAgeDays: 5,
        feedbackCoveragePercent: 33,
        pendingReviews: [
          {
            commissionId: 'commission-example',
            commissionName: 'Example Commission',
            runId: 'run-old',
            ranAt: '2026-08-19T12:00:00.000Z',
            ageDays: 5,
          },
          {
            commissionId: 'commission-example',
            commissionName: 'Example Commission',
            runId: 'run-new',
            ranAt: '2026-08-23T12:00:00.000Z',
            ageDays: 1,
          },
        ],
      },
    });

    expect(actions).toHaveLength(2);
    expect(actions.map((action) => action.id)).toEqual([
      'creative-feedback:commission-example:run-old',
      'creative-feedback:commission-example:run-new',
    ]);
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        occurrence: 'run-old',
        timestamp: '2026-08-19T12:00:00.000Z',
        required: false,
        isRecommendation: true,
        severity: 'high',
      }),
      expect.objectContaining({
        occurrence: 'run-new',
        timestamp: '2026-08-23T12:00:00.000Z',
        required: false,
        isRecommendation: true,
        severity: 'medium',
      }),
    ]));
  });

  it('does not create actions from unavailable metrics', () => {
    expect(buildProductActions({
      post: { status: 'unavailable' },
      creativeCommissions: { status: 'unavailable' },
    })).toEqual([]);
  });
});

describe('toProductMetricsAggregate', () => {
  it('keeps user-facing action details out of the Layered Intelligence payload', () => {
    const result = toProductMetricsAggregate({
      today,
      post: { status: 'ok', completedToday: false },
      creativeCommissions: {
        status: 'ok',
        unreviewedRenders: 1,
        pendingReviews: [{ commissionName: 'Example Commission', commissionId: 'commission-example', runId: 'run-example' }],
      },
      actions: [{ title: 'Creative feedback overdue: Example Commission', link: '/creative-commission/commission-example' }],
    });

    expect(result).toEqual({
      today,
      post: { status: 'ok', completedToday: false },
      creativeCommissions: { status: 'ok', unreviewedRenders: 1 },
    });
  });

  it('omits disabled features from the intelligence aggregate', () => {
    const result = toProductMetricsAggregate({
      today,
      post: { status: 'disabled', reason: 'instance-feature-disabled' },
      creativeCommissions: { status: 'unavailable', reason: 'creative-read-failed' },
    });

    expect(result).toEqual({
      today,
      creativeCommissions: { status: 'unavailable', reason: 'creative-read-failed' },
    });
  });
});
