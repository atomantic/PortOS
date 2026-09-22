import { describe, expect, it } from 'vitest';
import { NOTIFICATION_TYPES } from '../lib/notificationTypes.js';
import {
  adaptNotification,
  adaptStoredReviewItem,
} from './reviewActionAdapters.js';

describe('review action adapters', () => {
  it('adapts memory approval records into explicit source operations', () => {
    const item = adaptStoredReviewItem({
      id: 'review-1',
      type: 'alert',
      title: 'Memory approval',
      description: 'A memory needs approval',
      status: 'pending',
      createdAt: '2026-09-20T00:00:00.000Z',
      metadata: { referenceId: 'memory-1', category: 'memory-approval' },
    });

    expect(item).toMatchObject({
      id: 'memory:memory-1',
      sourceRef: 'memory-1',
      actionKind: 'memory.approval',
      sourceOwned: true,
      operations: [
        { id: 'approve', available: true },
        { id: 'reject', available: true },
      ],
    });
  });

  it('gives an uncorrelated legacy alert a permanent resolve, not the generic todo completion', () => {
    const item = adaptStoredReviewItem({
      id: 'legacy-1',
      type: 'alert',
      title: 'Legacy alert',
      status: 'pending',
      metadata: {},
    });

    expect(item).toMatchObject({
      id: 'review:legacy-1',
      actionKind: 'review.triage',
      triageOnly: true,
      sourceOwned: true,
      operations: [{ id: 'complete', label: 'Mark resolved', available: true }],
    });
  });

  it('keeps a link-only legacy alert as triage with its drill-down', () => {
    const item = adaptStoredReviewItem({
      id: 'legacy-linked',
      type: 'alert',
      title: 'Legacy scan alert',
      status: 'pending',
      metadata: { link: '/review/legacy-linked' },
    });

    expect(item).toMatchObject({
      id: 'review:legacy-linked',
      actionKind: 'review.triage',
      drillTo: '/review/legacy-linked',
    });
  });

  it('gives a goal-fidelity hold a permanent resolve operation (#8007)', () => {
    const item = adaptStoredReviewItem({
      id: 'review-3',
      type: 'alert',
      title: 'Goal-fidelity hold: run agent-1 may have built the wrong thing',
      status: 'pending',
      metadata: { referenceId: 'agent-1', category: 'goal-fidelity', agentId: 'agent-1' },
    });

    expect(item).toMatchObject({
      id: 'goal-fidelity:agent-1',
      sourceRef: 'agent-1',
      actionKind: 'goal-fidelity.review',
      required: true,
      sourceOwned: true,
      operations: [{ id: 'complete', label: 'Mark resolved', available: true }],
    });
  });

  it('does not admit a paused automation without its series identity', () => {
    expect(adaptStoredReviewItem({
      id: 'paused-run-only',
      type: 'alert',
      title: 'Paused automation',
      status: 'pending',
      metadata: { category: 'autopilot-paused', runId: 'run-1' },
    })).toBeNull();
  });

  it('leaves generic client-error alerts in history/context', () => {
    expect(adaptStoredReviewItem({
      id: 'error-1',
      type: 'alert',
      title: 'Client error',
      status: 'pending',
      metadata: { category: 'client-error', referenceId: 'client-error:hash' },
    })).toBeNull();
  });

  it('correlates a memory notification with the same canonical action id', () => {
    const item = adaptNotification({
      id: 'notification-1',
      type: NOTIFICATION_TYPES.MEMORY_APPROVAL,
      title: 'Memory needs approval',
      description: 'Review this memory',
      timestamp: '2026-09-20T00:00:00.000Z',
      link: '/cos/memory',
      metadata: { memoryId: 'memory-1' },
    });

    expect(item).toMatchObject({
      id: 'memory:memory-1',
      sourceRef: 'memory-1',
      required: true,
      operations: [
        { id: 'approve', available: true },
        { id: 'reject', available: true },
      ],
    });
  });

  it('requires a concrete reference and drill-down for actionable notifications', () => {
    expect(adaptNotification({
      id: 'notification-2',
      type: NOTIFICATION_TYPES.PLAN_QUESTION,
      title: 'Plan question',
      message: 'Choose a direction',
      metadata: {},
    })).toBeNull();
  });

  it('gives a plan-question notification a permanent resolve operation (#8007)', () => {
    const item = adaptNotification({
      id: 'notification-3',
      type: NOTIFICATION_TYPES.PLAN_QUESTION,
      title: 'Plan question',
      message: 'Choose a direction',
      link: '/apps/example/documents',
      metadata: { agentId: 'agent-1' },
    });

    expect(item).toMatchObject({
      id: 'plan:agent-1',
      sourceRef: 'agent-1',
      required: true,
      operations: [{ id: 'complete', label: 'Mark resolved', available: true }],
    });
  });

  it('gives a paused-autopilot notification a permanent resolve operation (#8007)', () => {
    const item = adaptNotification({
      id: 'notification-4',
      type: NOTIFICATION_TYPES.AUTOPILOT_PAUSED,
      title: 'Autopilot paused',
      description: 'Needs human review',
      link: '/pipeline/series/series-1',
      metadata: { autopilotPauseSeriesId: 'series-1', runId: 'run-1' },
    });

    expect(item).toMatchObject({
      id: 'autopilot:series-1:run-1',
      sourceRef: 'series-1:run-1',
      required: true,
      operations: [{ id: 'complete', label: 'Mark resolved', available: true }],
    });
  });
});
