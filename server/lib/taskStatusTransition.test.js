/**
 * Contract for the status-transition descriptor (#6620).
 *
 * `writeTaskUpdate`'s own boundary tests (services/cosTaskStore.test.js) are the
 * behavioral oracle — these pin the classification itself, which now answers for
 * seven separate lifecycle rules at once. The cases below are distinct transition
 * CLASSES, not permutations: each one is a different answer the seven rules read.
 */

import { describe, it, expect } from 'vitest';
import { resolveTaskStatusTransition, isTerminalTaskStatus } from './taskStatusTransition.js';

describe('isTerminalTaskStatus', () => {
  it('recognizes exactly completed and blocked', () => {
    expect(isTerminalTaskStatus('completed')).toBe(true);
    expect(isTerminalTaskStatus('blocked')).toBe(true);
    expect(isTerminalTaskStatus('in_progress')).toBe(false);
    expect(isTerminalTaskStatus('challenged')).toBe(false);
    expect(isTerminalTaskStatus(undefined)).toBe(false);
  });
});

describe('resolveTaskStatusTransition', () => {
  it('classifies a revive (blocked → pending)', () => {
    const t = resolveTaskStatusTransition('blocked', 'pending');
    expect(t.action).toBe('unblocked');
    expect(t.isRevive).toBe(true);
    expect(t.leavesBlocked).toBe(true);
    expect(t.leavesInProgress).toBe(true);
    expect(t.isTerminal).toBe(false);
  });

  it('classifies a requeue (in_progress → pending)', () => {
    const t = resolveTaskStatusTransition('in_progress', 'pending');
    expect(t.action).toBe('requeued');
    expect(t.isRequeue).toBe(true);
    // The requeue releases both in-flight-only subsystems in the same write.
    expect(t.leavesInProgress).toBe(true);
    expect(t.leavesBlocked).toBe(false);
  });

  // A patch with NO status is not a transition. Collapsing absent into "not
  // in_progress" would make every lease-renewal heartbeat retire the running
  // task's own retry hold and federation lease.
  it('treats an absent status as releasing nothing', () => {
    const t = resolveTaskStatusTransition('in_progress', undefined);
    expect(t.action).toBe('updated');
    expect(t.leavesInProgress).toBe(false);
    expect(t.leavesBlocked).toBe(false);
    expect(t.entersInProgress).toBe(false);
    expect(t.isTerminal).toBe(false);
    // Same for the empty string, which `writeTaskUpdate` also declines to write.
    expect(resolveTaskStatusTransition('blocked', '').leavesBlocked).toBe(false);
  });

  // `isTerminal` keys on the PATCH, not the resulting state: editing an
  // already-completed task's description must not re-run the one-shot terminal
  // cleanups (the resume-pointer drop) a second time.
  it('does not report an edit to an already-terminal task as terminal', () => {
    expect(resolveTaskStatusTransition('completed', undefined).isTerminal).toBe(false);
    expect(resolveTaskStatusTransition('completed', 'completed').isTerminal).toBe(true);
  });

  // A spawn is the only write that enters in_progress, and it must NOT read as
  // leaving it — otherwise the claim it carries is stripped by the same write.
  it('classifies a spawn (pending → in_progress)', () => {
    const t = resolveTaskStatusTransition('pending', 'in_progress');
    expect(t.entersInProgress).toBe(true);
    expect(t.leavesInProgress).toBe(false);
    expect(t.action).toBe('updated');
  });

  // Reaching `pending` from anywhere else is an ordinary edit, not a revive or a
  // requeue — only those two flips wake the scheduler.
  it('does not treat pending → pending as a revive or requeue', () => {
    const t = resolveTaskStatusTransition('pending', 'pending');
    expect(t.action).toBe('updated');
    expect(t.isRevive).toBe(false);
    expect(t.isRequeue).toBe(false);
  });

  // Blocking a running task leaves in_progress AND is terminal, but is not
  // "leaving blocked" — the blocked metadata this write is stamping must survive.
  it('classifies in_progress → blocked without clearing the block it just set', () => {
    const t = resolveTaskStatusTransition('in_progress', 'blocked');
    expect(t.isTerminal).toBe(true);
    expect(t.leavesInProgress).toBe(true);
    expect(t.leavesBlocked).toBe(false);
  });
});
