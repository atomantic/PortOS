import { describe, expect, it, vi } from 'vitest';
import { readReleaseSynchronizationOutbox } from './releaseSynchronizationStore.js';
import { retirementCheckoutIdentityFromPointer } from '../lib/retirementCheckoutObservation.js';
import {
  projectTaskReleaseMilestones,
  projectAgentReleaseMilestones,
  projectTaskSourceReleaseMilestones,
  getProjectedTask,
  getProjectedAgent,
  getProjectedAgentList,
} from './releaseSynchronizationProjection.js';

vi.mock('./releaseSynchronizationStore.js', () => ({
  readReleaseSynchronizationOutbox: vi.fn(),
  saveReleaseSynchronization: vi.fn(),
}));

describe('releaseSynchronizationProjection', () => {
  const identity = 'd'.repeat(64);
  const publication = {
    identity,
    status: 'verified',
    tag: 'v1.2.3',
    releaseUrl: 'https://github.com/example/repo/releases/tag/v1.2.3',
    publishedAt: '2026-01-01T10:00:00Z',
    repository: 'example/repo', promotionPrNumber: 12, candidateBranch: 'codex/release-publisher', candidateHead: 'a'.repeat(40),
  };
  const pointer = { dev: '1', ino: '2', birthtimeNs: '3' };
  const seed = { version: 1, agentId: 'publisher-agent-1', startedAt: '2026-01-01T09:00:00Z', seededAt: '2026-01-01T09:00:01Z',
    repoPath: '/example/repo', path: '/example/publisher', branch: publication.candidateBranch, repository: pointer, checkout: pointer,
    incarnation: { pointer, gitdir: { path: '/example/repo/.git/worktrees/publisher', ...pointer } } };
  const target = { agentId: seed.agentId, repoPath: seed.repoPath, branch: seed.branch, path: seed.path,
    head: publication.candidateHead, checkoutIdentity: retirementCheckoutIdentityFromPointer(pointer), createdAt: seed.seededAt };
  const entry = {
    version: 1,
    identity,
    owner: {
      agentId: 'publisher-agent-1',
      taskId: 'publisher-task-1',
      startedAt: '2026-01-01T09:00:00Z',
      workspace: '/example/repo',
    },
    publication,
    checkouts: [seed],
    task: {
      id: `task-release-sync-${identity}`,
      metadata: {
        releaseSynchronization: {
          version: 1,
          identity,
          publisherAgentId: 'publisher-agent-1',
          publisherTaskId: 'publisher-task-1',
        },
      },
    },
    obligations: {
      synchronizationPr: {
        status: 'verified',
        evidence: {
          prUrl: 'https://github.com/example/repo/pull/42',
          headSha: 'c'.repeat(40),
        },
      },
      retirement: { evidence: { checkouts: [target], receipts: [{ ...target, branchDeleted: true, archiveDir: null, retiredAt: '2026-01-01T10:00:00Z' }],
        publisherReview: { branch: seed.branch, path: seed.path, head: publication.candidateHead,
          checkoutIdentity: target.checkoutIdentity, prUrl: 'https://github.com/example/repo/pull/12', receipt: null, models: [] } } },
    },
    synchronization: {
      status: 'verified',
      attempts: 1,
      checkedAt: '2026-01-01T11:00:00Z',
      verifiedAt: '2026-01-01T11:00:00Z',
      blocker: null,
      retryAt: null,
    },
  };
  const outbox = {
    version: 1,
    publications: {
      [identity]: entry,
    },
  };

  it('projects release publication and synchronization onto parent and continuation tasks', () => {
    const continuationTask = { id: `task-release-sync-${identity}`, metadata: {} };
    const projectedContinuation = projectTaskReleaseMilestones(continuationTask, entry);
    expect(projectedContinuation.metadata.releasePublication).toEqual(publication);
    expect(projectedContinuation.metadata.releaseSynchronization).toEqual({
      version: 1,
      identity,
      status: 'verified',
      prUrl: 'https://github.com/example/repo/pull/42',
      headSha: 'c'.repeat(40),
      blocker: null,
      verifiedAt: '2026-01-01T11:00:00Z',
      checkedAt: '2026-01-01T11:00:00Z',
      retryAt: null,
      tag: 'v1.2.3',
      releaseUrl: 'https://github.com/example/repo/releases/tag/v1.2.3',
      publishedAt: '2026-01-01T10:00:00Z',
      publisherAgentId: 'publisher-agent-1',
      publisherTaskId: 'publisher-task-1',
      taskId: `task-release-sync-${identity}`,
    });

    const parentTask = { id: 'publisher-task-1', metadata: {} };
    const projectedParent = projectTaskReleaseMilestones(parentTask, outbox);
    expect(projectedParent.metadata.releasePublication).toEqual(publication);
    expect(projectedParent.metadata.releaseSynchronization.identity).toBe(identity);

    // Unmatched task returns unchanged
    expect(projectTaskReleaseMilestones({ id: 'unrelated-task', metadata: {} }, outbox)).toEqual({
      id: 'unrelated-task',
      metadata: {},
    });
  });

  it('projects the completed publication head rather than an earlier actual inspection', () => {
    const completedHead = 'e'.repeat(40);
    const local = { ...entry, obligations: { localReview: { evidence: { receipt: { version: 2, completedHead, reviewedHead: 'f'.repeat(40) } } } } };
    expect(projectTaskReleaseMilestones({ id: 'example', metadata: {} }, local).metadata.releaseSynchronization.headSha).toBe(completedHead);
    local.obligations.localReview.evidence.receipt = { version: 1, reviewedHead: completedHead };
    expect(projectTaskReleaseMilestones({ id: 'example', metadata: {} }, local).metadata.releaseSynchronization.headSha).toBe(completedHead);
  });

  it('shows an operator reset without claiming the historical synchronization succeeded', () => {
    const legacy = { ...entry, checkouts: [], synchronization: { status: 'blocked', blocker: 'publisher-candidate-checkout-unverified' },
      operatorReset: { version: 1, identity, resetAt: '2026-01-01T12:00:00Z', actor: 'local-operator',
        reason: 'Start from main', previousStatus: 'blocked', previousBlocker: 'publisher-candidate-checkout-unverified', checkouts: [] } };
    const projected = projectTaskReleaseMilestones({ id: 'example', metadata: {} }, legacy).metadata.releaseSynchronization;
    expect(projected).toMatchObject({ status: 'blocked', blocker: 'publisher-candidate-checkout-unverified', operatorReset: legacy.operatorReset });
    expect(projected.nextAction).toContain('remains unverified');
  });

  it('projects release publication and synchronization onto agents', () => {
    const publisher = { id: 'publisher-agent-1', metadata: { releasePublication: publication } };
    const projectedPublisher = projectAgentReleaseMilestones(publisher, outbox);
    expect(projectedPublisher.metadata.releaseSynchronization.status).toBe('verified');
    expect(projectedPublisher.metadata.releaseSynchronization.prUrl).toBe('https://github.com/example/repo/pull/42');
  });

  it('does not falsely project publisher synchronization onto earlier attempts sharing the task ID', () => {
    // Earlier attempt on the same publisher task ID that failed
    const earlierAttempt = {
      id: 'publisher-agent-failed-attempt',
      taskId: 'publisher-task-1',
      metadata: {},
    };
    const projectedEarlier = projectAgentReleaseMilestones(earlierAttempt, outbox);
    expect(projectedEarlier.metadata.releaseSynchronization).toBeUndefined();

    // Successful attempt matching owner.agentId
    const successfulAttempt = {
      id: 'publisher-agent-1',
      taskId: 'publisher-task-1',
      metadata: {},
    };
    const projectedSuccess = projectAgentReleaseMilestones(successfulAttempt, outbox);
    expect(projectedSuccess.metadata.releaseSynchronization.status).toBe('verified');
  });

  it('projects whole task sources in queue and history views', () => {
    const source = {
      tasks: [
        { id: `task-release-sync-${identity}`, metadata: {} },
        { id: 'other-task', metadata: {} },
      ],
      completed: [
        { id: 'publisher-task-1', metadata: {} },
      ],
    };
    const projected = projectTaskSourceReleaseMilestones(source, outbox);
    expect(projected.tasks[0].metadata.releaseSynchronization.status).toBe('verified');
    expect(projected.tasks[1].metadata.releaseSynchronization).toBeUndefined();
    expect(projected.completed[0].metadata.releaseSynchronization.status).toBe('verified');
  });

  it('projects completed-task pages with items array', () => {
    const page = {
      items: [
        { id: `task-release-sync-${identity}`, metadata: {} },
        { id: 'publisher-task-1', metadata: {} },
        { id: 'regular-task', metadata: {} },
      ],
      total: 3,
      nextCursor: null,
    };
    const projected = projectTaskSourceReleaseMilestones(page, outbox);
    expect(projected.items[0].metadata.releaseSynchronization.status).toBe('verified');
    expect(projected.items[1].metadata.releaseSynchronization.status).toBe('verified');
    expect(projected.items[2].metadata.releaseSynchronization).toBeUndefined();
  });

  it('projects agent list with release milestones', async () => {
    readReleaseSynchronizationOutbox.mockResolvedValue(outbox);
    const agents = [
      { id: 'publisher-agent-1', metadata: {} },
      { id: 'unrelated-agent', metadata: {} },
    ];
    const projected = await getProjectedAgentList(agents);
    expect(projected[0].metadata.releaseSynchronization.status).toBe('verified');
    expect(projected[1].metadata.releaseSynchronization).toBeUndefined();
  });

  it('gets projected task and agent records asynchronously', async () => {
    readReleaseSynchronizationOutbox.mockResolvedValue(outbox);
    const task = await getProjectedTask({ id: 'publisher-task-1', metadata: {} });
    expect(task.metadata.releaseSynchronization.status).toBe('verified');

    const agent = await getProjectedAgent({ id: 'publisher-agent-1', metadata: {} });
    expect(agent.metadata.releaseSynchronization.status).toBe('verified');
  });
});
