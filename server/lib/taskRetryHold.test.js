import { describe, expect, it } from 'vitest';
import {
  RETRY_HOLD_GRACE_MS,
  retryHoldMetadata,
  clearedRetryHoldMetadata,
  isRetryHeld,
  isRetryHoldOwner,
  isStaleRetryHold,
} from './taskRetryHold.js';

const NOW = Date.parse('2026-08-02T12:00:00.000Z');

describe('retryHoldMetadata / clearedRetryHoldMetadata', () => {
  // The marker VALUE is the arming run's id, so the release is owner-scoped.
  it('arms the marker with the owning agent id and an ISO stamp', () => {
    expect(retryHoldMetadata('agent-x', NOW)).toEqual({
      retryPendingCleanup: 'agent-x',
      retryPendingSince: '2026-08-02T12:00:00.000Z',
    });
  });

  it('falls back to an unattributed hold when no agent id is known', () => {
    expect(retryHoldMetadata(null, NOW).retryPendingCleanup).toBe(true);
  });

  // `undefined` — not null: updateTask DELETES undefined keys from the merged
  // metadata, while a null survives and TASKS.md serializes it as the string
  // "null", which would read back as a live marker on the next boot.
  it('clears with undefined so updateTask drops the keys entirely', () => {
    const cleared = clearedRetryHoldMetadata();
    expect(cleared.retryPendingCleanup).toBeUndefined();
    expect(cleared.retryPendingSince).toBeUndefined();
    expect(Object.keys(cleared)).toEqual(['retryPendingCleanup', 'retryPendingSince']);
    expect(isRetryHeld({ ...retryHoldMetadata('agent-x', NOW), ...cleared })).toBe(false);
  });
});

describe('isRetryHeld', () => {
  it('reads an agent id, the legacy boolean, and its markdown round-trip string', () => {
    expect(isRetryHeld({ retryPendingCleanup: 'agent-x' })).toBe(true);
    expect(isRetryHeld({ retryPendingCleanup: true })).toBe(true);
    expect(isRetryHeld({ retryPendingCleanup: 'true' })).toBe(true);
  });

  // The markdown round-trip stringifies every value, so the falsy forms have to be
  // recognized as strings or a cleared marker would read as a live hold.
  it('is false for anything else', () => {
    expect(isRetryHeld({ retryPendingCleanup: false })).toBe(false);
    expect(isRetryHeld({ retryPendingCleanup: 'false' })).toBe(false);
    expect(isRetryHeld({ retryPendingCleanup: 'null' })).toBe(false);
    expect(isRetryHeld({ retryPendingCleanup: 'undefined' })).toBe(false);
    expect(isRetryHeld({ retryPendingCleanup: '' })).toBe(false);
    expect(isRetryHeld({})).toBe(false);
    expect(isRetryHeld(null)).toBe(false);
    expect(isRetryHeld(undefined)).toBe(false);
  });
});

// Only the run that armed the hold may release it: a slow cleanup from a previous
// attempt landing after the NEXT attempt failed and armed its own hold would
// otherwise make the task spawnable while that attempt's cleanup is still running.
describe('isRetryHoldOwner', () => {
  it('is true only for the arming agent', () => {
    expect(isRetryHoldOwner({ retryPendingCleanup: 'agent-x' }, 'agent-x')).toBe(true);
    expect(isRetryHoldOwner({ retryPendingCleanup: 'agent-x' }, 'agent-y')).toBe(false);
    expect(isRetryHoldOwner({ retryPendingCleanup: 'agent-x' }, null)).toBe(false);
  });

  it('lets anyone release an unattributed (legacy) hold', () => {
    expect(isRetryHoldOwner({ retryPendingCleanup: true }, 'agent-y')).toBe(true);
    expect(isRetryHoldOwner({ retryPendingCleanup: 'true' }, 'agent-y')).toBe(true);
  });

  it('is false when there is no hold at all', () => {
    expect(isRetryHoldOwner({}, 'agent-x')).toBe(false);
    expect(isRetryHoldOwner(null, 'agent-x')).toBe(false);
  });
});

describe('isStaleRetryHold', () => {
  // A fresh hold means some in-process cleanup is still expected to release it;
  // the sweep must leave it alone or it resolves the pointer mid-merge.
  it('is not stale inside the grace window', () => {
    expect(isStaleRetryHold(retryHoldMetadata('agent-x', NOW), NOW + RETRY_HOLD_GRACE_MS - 1)).toBe(false);
  });

  it('is stale once the grace window elapses', () => {
    expect(isStaleRetryHold(retryHoldMetadata('agent-x', NOW), NOW + RETRY_HOLD_GRACE_MS)).toBe(true);
  });

  // The marker is the evidence; the stamp is only the liveness hint. A hold we
  // cannot date must not strand the task forever.
  it('treats a missing or unparseable stamp as stale', () => {
    expect(isStaleRetryHold({ retryPendingCleanup: true }, NOW)).toBe(true);
    expect(isStaleRetryHold({ retryPendingCleanup: true, retryPendingSince: 'not-a-date' }, NOW)).toBe(true);
  });

  it('is false for a task that is not held at all, however old', () => {
    expect(isStaleRetryHold({ retryPendingSince: new Date(0).toISOString() }, NOW)).toBe(false);
    expect(isStaleRetryHold({}, NOW)).toBe(false);
  });
});
