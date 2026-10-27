import { describe, expect, it } from 'vitest';
import {
  buildReleaseSynchronizationPayload,
  findMatchingOutboxEntry,
  projectTaskReleaseMilestones,
  projectAgentReleaseMilestones,
  projectTaskSourceReleaseMilestones,
} from './releaseSynchronizationProjection.js';

describe('releaseSynchronizationProjection', () => {
  const identity = 'd'.repeat(64);
  const publication = {
    identity,
    status: 'verified',
    tag: 'v1.2.3',
    releaseUrl: 'https://github.com/example/repo/releases/tag/v1.2.3',
    publishedAt: '2026-01-01T10:00:00Z',
  };
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

  it('builds a complete synchronization projection payload', () => {
    const payload = buildReleaseSynchronizationPayload(entry);
    expect(payload).toEqual({
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
  });

  it('matches outbox entries by identity, task ID (continuation and parent), and agent ID', () => {
    // By identity
    expect(findMatchingOutboxEntry({ metadata: { releasePublication: { identity } } }, outbox)).toBe(entry);
    expect(findMatchingOutboxEntry({ metadata: { releaseSynchronization: { identity } } }, outbox)).toBe(entry);

    // By task ID
    expect(findMatchingOutboxEntry({ id: `task-release-sync-${identity}` }, outbox)).toBe(entry);
    expect(findMatchingOutboxEntry({ id: 'publisher-task-1' }, outbox)).toBe(entry);

    // By agent ID
    expect(findMatchingOutboxEntry({ id: 'publisher-agent-1' }, outbox)).toBe(entry);

    // Unmatched
    expect(findMatchingOutboxEntry({ id: 'unrelated-task' }, outbox)).toBeNull();
  });

  it('projects release publication and synchronization onto parent and continuation tasks', () => {
    const continuationTask = { id: `task-release-sync-${identity}`, metadata: {} };
    const projectedContinuation = projectTaskReleaseMilestones(continuationTask, entry);
    expect(projectedContinuation.metadata.releasePublication).toEqual(publication);
    expect(projectedContinuation.metadata.releaseSynchronization.identity).toBe(identity);
    expect(projectedContinuation.metadata.releaseSynchronization.status).toBe('verified');
    expect(projectedContinuation.metadata.releaseSynchronization.prUrl).toBe('https://github.com/example/repo/pull/42');

    const parentTask = { id: 'publisher-task-1', metadata: {} };
    const projectedParent = projectTaskReleaseMilestones(parentTask, outbox);
    expect(projectedParent.metadata.releasePublication).toEqual(publication);
    expect(projectedParent.metadata.releaseSynchronization.identity).toBe(identity);
  });

  it('projects release publication and synchronization onto agents', () => {
    const publisher = { id: 'publisher-agent-1', metadata: { releasePublication: publication } };
    const projectedPublisher = projectAgentReleaseMilestones(publisher, outbox);
    expect(projectedPublisher.metadata.releaseSynchronization.status).toBe('verified');
    expect(projectedPublisher.metadata.releaseSynchronization.prUrl).toBe('https://github.com/example/repo/pull/42');
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
});
