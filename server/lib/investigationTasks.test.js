import { describe, it, expect } from 'vitest';
import {
  CLIENT_INVESTIGATION_DELIVERY,
  CLIENT_INVESTIGATION_KIND,
  INVESTIGATION_HEADLINE_PREFIX,
  INVESTIGATION_TASK_DELIVERY,
  clientInvestigationFingerprint,
  MAX_AUTO_RETRIES_PER_TASK,
  RETRY_SKIP_REASONS,
  autoRetryCount,
  autoRetryMetadata,
  buildInvestigationFingerprint,
  investigationFingerprint,
  isAutoApprovableInvestigation,
  isInvestigationTask,
  resolveInvestigationRetryTargets,
} from './investigationTasks.js';
import { AGENT_PAUSED_CATEGORY } from './taskPauseHold.js';

const blocked = (id, metadata = {}) => ({ id, status: 'blocked', metadata: { blockedCategory: 'unknown', ...metadata } });

const investigation = (overrides = {}) => ({
  id: 'sys-inv',
  status: 'completed',
  description: `${INVESTIGATION_HEADLINE_PREFIX} [unknown:task:none]: boom`,
  ...overrides,
  metadata: { isInvestigation: true, affectedTasks: ['task-1'], ...(overrides.metadata || {}) },
});

const index = (...tasks) => new Map(tasks.map(t => [t.id, t]));

describe('isInvestigationTask', () => {
  it('recognizes the durable marker, including the markdown round-trip string', () => {
    expect(isInvestigationTask({ metadata: { isInvestigation: true } })).toBe(true);
    expect(isInvestigationTask({ metadata: { isInvestigation: 'true' } })).toBe(true);
  });

  it('falls back to the legacy headline for investigations that predate the marker', () => {
    expect(isInvestigationTask({ description: `  ${INVESTIGATION_HEADLINE_PREFIX} [x]: boom` })).toBe(true);
  });

  it('is false for ordinary tasks and for a falsy marker string', () => {
    expect(isInvestigationTask({ description: 'Fix the thing' })).toBe(false);
    expect(isInvestigationTask({ metadata: { isInvestigation: 'false' } })).toBe(false);
    expect(isInvestigationTask(null)).toBe(false);
  });
});

describe('isAutoApprovableInvestigation', () => {
  const task = {
    status: 'pending',
    approvalRequired: true,
    metadata: { isInvestigation: true },
  };

  it('admits a held investigation only when explicitly configured', () => {
    expect(isAutoApprovableInvestigation(task, { autoApproveInvestigations: true })).toBe(true);
    expect(isAutoApprovableInvestigation(task, { autoApproveInvestigations: false })).toBe(false);
  });

  it('does not override ordinary, completed, or already-approved tasks', () => {
    expect(isAutoApprovableInvestigation({ ...task, description: 'ordinary', metadata: {} }, { autoApproveInvestigations: true })).toBe(false);
    expect(isAutoApprovableInvestigation({ ...task, status: 'completed' }, { autoApproveInvestigations: true })).toBe(false);
    expect(isAutoApprovableInvestigation({ ...task, approvalRequired: false }, { autoApproveInvestigations: true })).toBe(false);
  });
});

describe('buildInvestigationFingerprint', () => {
  it('keys on category, analysisType/taskType, and app — never the free-text message', () => {
    expect(buildInvestigationFingerprint(
      { id: 't', taskType: 'internal', metadata: { analysisType: 'app-improve', app: 'ExampleApp' } },
      { category: 'startup-failure', message: 'raw output line that varies per run' }
    )).toBe('startup-failure:app-improve:ExampleApp');
  });

  it('falls back to taskType, then generic sentinels, when analysisType/app are absent', () => {
    expect(buildInvestigationFingerprint({ id: 't', taskType: 'user', metadata: {} }, { category: 'unknown' })).toBe('unknown:user:none');
    expect(buildInvestigationFingerprint({ id: 't' }, null)).toBe('unknown:task:none');
  });

  it('builds the same three-segment key for producers with no originating task', () => {
    expect(investigationFingerprint({ category: 'auth-error', kind: 'provider-failure', scope: 'Example CLI' }))
      .toBe('auth-error:provider-failure:Example CLI');
    expect(investigationFingerprint({})).toBe('unknown:task:none');
  });
});

describe('resolveInvestigationRetryTargets', () => {
  it('revives a still-blocked affected task', () => {
    const task = blocked('task-1');
    const { targets, skipped } = resolveInvestigationRetryTargets({
      investigation: investigation(), tasksById: index(task)
    });
    expect(targets).toEqual([task]);
    expect(skipped).toEqual([]);
  });

  it('does nothing for a task that is not an investigation', () => {
    const task = blocked('task-1');
    const notAnInvestigation = {
      id: 'sys-x', status: 'completed', description: 'Ordinary work',
      metadata: { affectedTasks: ['task-1'] }
    };
    expect(resolveInvestigationRetryTargets({ investigation: notAnInvestigation, tasksById: index(task) }))
      .toEqual({ targets: [], skipped: [] });
  });

  it('does nothing while the investigation is still open — a diagnosis in flight resolved nothing', () => {
    for (const status of ['pending', 'in_progress', 'blocked', 'challenged']) {
      expect(resolveInvestigationRetryTargets({
        investigation: investigation({ status }), tasksById: index(blocked('task-1'))
      }).targets).toEqual([]);
    }
  });

  it('does nothing for an auto-expired completion — the reaper cleaned up, nobody fixed anything', () => {
    expect(resolveInvestigationRetryTargets({
      investigation: investigation({ metadata: { resolution: 'auto-expired' } }),
      tasksById: index(blocked('task-1'))
    }).targets).toEqual([]);
  });

  it('reports why each affected task was skipped', () => {
    const inv = investigation({
      metadata: { affectedTasks: ['gone', 'running', 'terminated', 'spent'] }
    });
    const { targets, skipped } = resolveInvestigationRetryTargets({
      investigation: inv,
      tasksById: index(
        { id: 'running', status: 'in_progress', metadata: {} },
        blocked('terminated', { blockedCategory: 'user-terminated' }),
        blocked('spent', { autoRetryCount: MAX_AUTO_RETRIES_PER_TASK }),
      )
    });
    expect(targets).toEqual([]);
    expect(skipped).toEqual([
      { taskId: 'gone', reason: RETRY_SKIP_REASONS.GONE },
      { taskId: 'running', reason: RETRY_SKIP_REASONS.NOT_BLOCKED },
      { taskId: 'terminated', reason: RETRY_SKIP_REASONS.BLOCK_NOT_AUTO_RETRYABLE },
      { taskId: 'spent', reason: RETRY_SKIP_REASONS.BUDGET_EXHAUSTED },
    ]);
  });

  // The first draft of this guard hand-wrote a `'user-paused'` category that
  // matches nothing (the real one is `agent-paused`) and omitted
  // `challenge-escalation` entirely — so a task a human paused, or one parked
  // awaiting their arbitration, was revived out from under them. Assert every
  // hands-off category by the constant it actually ships with.
  it.each([
    ['a run the user stopped', 'user-terminated'],
    ['a run the user paused', AGENT_PAUSED_CATEGORY],
    ['a task awaiting the user’s arbitration', 'challenge-escalation'],
    ['a task waiting on an unresolvable app', 'app-unresolved'],
    ['a task waiting on an invalid workspace', 'workspace-invalid'],
    ['a cooldown that revives itself', 'orphan-cooldown'],
  ])('never revives %s', (_label, blockedCategory) => {
    const { targets, skipped } = resolveInvestigationRetryTargets({
      investigation: investigation(),
      tasksById: index(blocked('task-1', { blockedCategory }))
    });
    expect(targets).toEqual([]);
    expect(skipped).toEqual([{ taskId: 'task-1', reason: RETRY_SKIP_REASONS.BLOCK_NOT_AUTO_RETRYABLE }]);
  });

  it('still revives a task that has retries left', () => {
    const task = blocked('task-1', { autoRetryCount: MAX_AUTO_RETRIES_PER_TASK - 1 });
    expect(resolveInvestigationRetryTargets({ investigation: investigation(), tasksById: index(task) }).targets)
      .toEqual([task]);
  });

  it('counts a task named twice only once — same-fingerprint failures union their id in', () => {
    const task = blocked('task-1');
    const inv = investigation({ metadata: { affectedTasks: ['task-1', 'task-1'] } });
    expect(resolveInvestigationRetryTargets({ investigation: inv, tasksById: index(task) }).targets)
      .toEqual([task]);
  });

  it('does nothing when the investigation names no affected task (legacy shape)', () => {
    expect(resolveInvestigationRetryTargets({
      investigation: investigation({ metadata: { affectedTasks: undefined } }),
      tasksById: index(blocked('task-1'))
    })).toEqual({ targets: [], skipped: [] });
  });
});

describe('autoRetryCount / autoRetryMetadata', () => {
  it('reads the count through the markdown round-trip and ignores garbage', () => {
    expect(autoRetryCount({ metadata: { autoRetryCount: 1 } })).toBe(1);
    expect(autoRetryCount({ metadata: { autoRetryCount: '2' } })).toBe(2);
    expect(autoRetryCount({ metadata: { autoRetryCount: 'nope' } })).toBe(0);
    expect(autoRetryCount({})).toBe(0);
  });

  it('increments the budget that survives the revive clearing failureCount', () => {
    expect(autoRetryMetadata(blocked('t', { autoRetryCount: 1 }), 'sys-inv', 1_700_000_000_000)).toEqual({
      autoRetryCount: 2,
      autoRetriedByInvestigation: 'sys-inv',
      autoRetriedAt: new Date(1_700_000_000_000).toISOString(),
    });
  });
});

describe('clientInvestigationFingerprint (#6043)', () => {
  const INSTALL_FAILURE = 'Fix Example Runtime installer failure at the download stage';

  it('is deterministic for the same submitted failure — that is what makes dedup work', () => {
    expect(clientInvestigationFingerprint({ description: INSTALL_FAILURE }))
      .toBe(clientInvestigationFingerprint({ description: INSTALL_FAILURE }));
  });

  it('separates two different install failures', () => {
    expect(clientInvestigationFingerprint({ description: INSTALL_FAILURE }))
      .not.toBe(clientInvestigationFingerprint({ description: 'Fix Example Runtime installer failure at the verify stage' }));
  });

  it('scopes by app the way an auto-filed key does', () => {
    expect(clientInvestigationFingerprint({ description: INSTALL_FAILURE, app: 'Example App' }))
      .not.toBe(clientInvestigationFingerprint({ description: INSTALL_FAILURE }));
  });

  it('keeps the client namespace out of reach of an auto-filed key', () => {
    // Auto-filed keys take their `kind` from an analysis / self-improvement /
    // task type, never this reserved value — so a client-derived key can neither
    // match an auto-filed investigation in the dedup scan nor evict it.
    const key = clientInvestigationFingerprint({ description: INSTALL_FAILURE });
    expect(key.split(':')[1]).toBe(CLIENT_INVESTIGATION_KIND);
    expect(buildInvestigationFingerprint(
      { taskType: CLIENT_INVESTIGATION_KIND, metadata: {} },
      { category: 'unknown' }
    )).not.toBe(key);
  });

  it('survives a description of nothing but punctuation rather than emitting a bare separator', () => {
    expect(clientInvestigationFingerprint({ description: '!!! ---' })).toBe(`unknown:${CLIENT_INVESTIGATION_KIND}:none`);
    expect(clientInvestigationFingerprint()).toBe(`unknown:${CLIENT_INVESTIGATION_KIND}:none`);
  });
});

describe('investigation delivery postures', () => {
  it('isolates a client-queued investigation exactly like an unattended one', () => {
    expect(CLIENT_INVESTIGATION_DELIVERY.useWorktree).toBe(INVESTIGATION_TASK_DELIVERY.useWorktree);
    expect(CLIENT_INVESTIGATION_DELIVERY.openPR).toBe(INVESTIGATION_TASK_DELIVERY.openPR);
  });

  it('reviews the client-queued PR instead of merging it on green — a human is present', () => {
    expect(INVESTIGATION_TASK_DELIVERY.prCompletion).toBe('merge-on-green');
    expect(CLIENT_INVESTIGATION_DELIVERY.prCompletion).toBe('review-then-merge');
  });
});
