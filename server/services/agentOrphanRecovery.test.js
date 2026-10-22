import { describe, it, expect } from 'vitest';
import { MAX_TOTAL_SPAWNS } from '../lib/cosValidation.js';
import { MAX_ORPHAN_RETRIES, ORPHAN_GUARDS, ORPHAN_RETRY_COOLDOWN_MS, classifyOrphanGuard, decideOrphanRetry } from './agentOrphanRecovery.js';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const MIN = 60 * 1000;
const decide = (metadata, wasInterrupted = false) =>
  decideOrphanRetry({ task: { metadata }, wasInterrupted, now: NOW });

// The #3202 budget contract: a genuine orphan pays a retry and arms the cooldown;
// a PortOS restart pays neither and gets its spawn refunded; the spawn ceiling
// bounds both.
describe('decideOrphanRetry', () => {
  it.each([
    ['first genuine orphan', { orphanRetryCount: 0, totalSpawnCount: 1 }, false, { outcome: 'requeue', retryCount: 1, totalSpawns: 1 }],
    ['last genuine retry still within budget', { orphanRetryCount: MAX_ORPHAN_RETRIES - 2, totalSpawnCount: 2 }, false, { outcome: 'requeue', retryCount: MAX_ORPHAN_RETRIES - 1, totalSpawns: 2 }],
    ['genuine orphan at the retry ceiling', { orphanRetryCount: MAX_ORPHAN_RETRIES - 1, totalSpawnCount: 3 }, false,
      { outcome: 'blocked', retryCount: MAX_ORPHAN_RETRIES, reason: `orphan retries exceeded (${MAX_ORPHAN_RETRIES}/${MAX_ORPHAN_RETRIES})` }],
    ['genuine orphan at the spawn ceiling', { orphanRetryCount: 0, totalSpawnCount: MAX_TOTAL_SPAWNS }, false,
      { outcome: 'blocked', reason: `total spawns exceeded (${MAX_TOTAL_SPAWNS}/${MAX_TOTAL_SPAWNS})` }],
    ['spawn ceiling is reported ahead of the retry ceiling', { orphanRetryCount: MAX_ORPHAN_RETRIES, totalSpawnCount: MAX_TOTAL_SPAWNS }, false,
      { outcome: 'blocked', reason: `total spawns exceeded (${MAX_TOTAL_SPAWNS}/${MAX_TOTAL_SPAWNS})` }],
    ['interrupted run is not charged and its spawn is refunded', { orphanRetryCount: 2, totalSpawnCount: 4 }, true,
      { outcome: 'requeue', retryCount: 2, totalSpawns: 3 }],
    ['interrupted run ignores the orphan retry ceiling', { orphanRetryCount: MAX_ORPHAN_RETRIES + 2, totalSpawnCount: 1 }, true,
      { outcome: 'requeue', retryCount: MAX_ORPHAN_RETRIES + 2, totalSpawns: 0 }],
    ['interrupted run is still bounded by the spawn ceiling after the refund', { orphanRetryCount: 0, totalSpawnCount: MAX_TOTAL_SPAWNS + 1 }, true,
      { outcome: 'blocked', retryCount: 0, totalSpawns: MAX_TOTAL_SPAWNS }],
    ['interrupted run never reads a negative spawn count', {}, true, { outcome: 'requeue', retryCount: 0, totalSpawns: 0 }],
  ])('%s', (_name, metadata, wasInterrupted, expected) => {
    expect(decide(metadata, wasInterrupted)).toMatchObject({ interrupted: wasInterrupted, ...expected });
  });

  describe('cooldown', () => {
    const recent = (minutesAgo) => new Date(NOW - minutesAgo * MIN).toISOString();

    it('holds a genuine orphan inside the window and reports the remaining minutes', () => {
      expect(decide({ orphanRetryCount: 1, totalSpawnCount: 2, lastOrphanedAt: recent(10) })).toMatchObject({
        outcome: 'cooldown', cooldownRemaining: ORPHAN_RETRY_COOLDOWN_MS - 10 * MIN, cooldownMinutes: 20,
        reason: 'Orphan retry cooldown (20m remaining)',
      });
    });

    it('requeues once the window has elapsed', () => {
      expect(decide({ orphanRetryCount: 1, totalSpawnCount: 2, lastOrphanedAt: recent(31) }).outcome).toBe('requeue');
    });

    it('does not cool down an interrupted run', () => {
      expect(decide({ orphanRetryCount: 1, totalSpawnCount: 2, lastOrphanedAt: recent(1) }, true).outcome).toBe('requeue');
    });

    it('blocks rather than cools down when the budget is spent', () => {
      expect(decide({ orphanRetryCount: MAX_ORPHAN_RETRIES - 1, totalSpawnCount: 3, lastOrphanedAt: recent(1) }).outcome).toBe('blocked');
    });

    it('treats an unparseable lastOrphanedAt as never orphaned', () => {
      expect(decide({ orphanRetryCount: 0, lastOrphanedAt: 'not-a-date' })).toMatchObject({ outcome: 'requeue', cooldownRemaining: 0 });
    });
  });
});

describe('orphan guard order', () => {
  it('pins the precedence between the guards', () => {
    expect(ORPHAN_GUARDS.map(guard => guard.reason)).toEqual([
      'terminal-block', 'private-security', 'already-handled', 'completed', 'content-refusal', 'deep-audit', 'retry-held',
    ]);
  });

  it('returns null for an ordinary orphan', () => {
    expect(classifyOrphanGuard({ status: 'in_progress', metadata: {} }, null)).toBeNull();
  });

  it('resolves a task matching several guards to the earliest one', () => {
    const task = { status: 'blocked', metadata: { blockedCategory: 'user-terminated', retryPendingCleanup: 'agent-dead' } };
    expect(classifyOrphanGuard(task, { executionInterruption: { category: 'content-refusal' } })).toBe('terminal-block');
  });
});
