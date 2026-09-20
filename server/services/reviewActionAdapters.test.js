import { describe, expect, it } from 'vitest';
import { NOTIFICATION_TYPES } from '../lib/notificationTypes.js';
import {
  adaptNotification,
  adaptStoredReviewItem,
  isSourceOwnedReviewItem,
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

  it('keeps uncorrelated legacy alerts as explicit triage, not generic completion', () => {
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
      operations: [{ id: 'triage', available: false }],
    });
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

  it('marks source-owned alerts as unavailable to generic completion', () => {
    expect(isSourceOwnedReviewItem({
      type: 'alert',
      metadata: { category: 'goal-fidelity' },
    })).toBe(true);
    expect(isSourceOwnedReviewItem({
      type: 'todo',
      metadata: {},
    })).toBe(false);
  });
});
