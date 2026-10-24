import { describe, expect, it, vi } from 'vitest';
import { inspectOrQueueCompletedReview } from './repoCleanupRecovery.js';

const target = { version: 1, repository: 'example/repo', repoPath: '/repo', branch: 'fix/work', prUrl: 'https://github.com/example/repo/pull/7', headSha: 'a'.repeat(40), worktreePath: '/repo-work', ownerId: 'owner', ownerStartedAt: '2026-01-01T00:00:00Z', ownerTaskId: 'original' };
const required = () => ({ disposition: 'review-required', reason: 'required-review-missing', agentId: 'owner', reviewTarget: target,
  originalTask: { id: 'original', metadata: { prCompletion: 'review-then-merge' } }, roster: { reviewers: ['codex'], optionalReviewers: [], usernames: [] } });
const input = { repoPath: '/repo', branch: target.branch, prUrl: target.prUrl, headSha: target.headSha, worktreePath: target.worktreePath };
function harness(inspection = required()) {
  let reservation = null;
  const lifecycle = {
    reserveRepoCleanupRecovery: vi.fn(async (_owner, _branch, observation) => {
      if (reservation) return { admitted: false, reason: 'cleanup-successor-owned' };
      reservation = { observation, phase: 'reserved' }; return { admitted: true };
    }),
    recordRepoCleanupRecovery: vi.fn(async (_owner, _branch, observation, patch) => {
      if (reservation?.observation === observation) Object.assign(reservation, patch);
      return true;
    }),
    recordCleanupOutcome: vi.fn(async () => true),
  };
  return { inspect: vi.fn(async () => inspection), permitted: vi.fn(async () => {}), lifecycle, spawn: vi.fn(async () => ({ id: 'review-1' })), reservation: () => reservation };
}

describe('completed cleanup review dispatch', () => {
  it.each([
    [{ id: 'review-1', blocked: 'Review coordinator retry budget exhausted or unreadable' }, 'blocked', 'Review coordinator retry budget exhausted or unreadable'],
    [{ id: 'review-1', deferred: true }, 'deferred', 'required-code-review-deferred'],
  ])('retains refused successors without claiming dispatch: %j', async (task, phase, reason) => {
    const deps = harness();
    deps.spawn.mockResolvedValue(task);
    expect(await inspectOrQueueCompletedReview(input, deps)).toEqual({ disposition: 'held', reason, taskId: 'review-1' });
    expect(deps.reservation()).toMatchObject({ phase, taskId: 'review-1', reason });
    expect(deps.lifecycle.recordCleanupOutcome).toHaveBeenCalledWith('owner', expect.objectContaining({ status: 'blocked', reason, taskId: 'review-1' }));
    for (let i = 0; i < 3; i++) await inspectOrQueueCompletedReview(input, deps);
    expect(deps.spawn).toHaveBeenCalledOnce();
  });

  it('creates one exact configured review owner across 70 scans and joins existing successors without reserving', async () => {
    const deps = harness();
    expect(await inspectOrQueueCompletedReview(input, deps)).toMatchObject({ disposition: 'queued-review', taskId: 'review-1' });
    for (let i = 0; i < 70; i++) expect(await inspectOrQueueCompletedReview(input, deps)).toMatchObject({ disposition: 'held' });
    expect(deps.spawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ originalAgentId: 'owner', reviewTarget: target, reviewers: ['codex'] }));
    expect(deps.reservation()).toMatchObject({ phase: 'dispatched', taskId: 'review-1' });
    const joined = harness({ disposition: 'join-existing', reason: 'review-successor-exists', taskId: 'review-1' });
    expect(await inspectOrQueueCompletedReview(input, joined)).toMatchObject({ disposition: 'join-existing', taskId: 'review-1' });
    expect(joined.lifecycle.reserveRepoCleanupRecovery).not.toHaveBeenCalled();
    expect(joined.spawn).not.toHaveBeenCalled();
  });

  it.each(['owner', 'head', 'policy', 'roster', 'paused'])('retains the reservation without dispatch when %s changes during durable admission', async change => {
    const deps = harness();
    const fresh = structuredClone(required());
    if (change === 'owner') fresh.agentId = 'replacement';
    if (change === 'head') fresh.reviewTarget.headSha = 'b'.repeat(40);
    if (change === 'policy') fresh.originalTask.metadata.prCompletion = 'merge-on-green';
    if (change === 'roster') fresh.roster.reviewers = ['claude'];
    deps.inspect.mockResolvedValueOnce(required()).mockResolvedValue(fresh);
    if (change === 'paused') deps.permitted.mockResolvedValueOnce().mockRejectedValue(new Error('automatic-retirement-paused'));
    expect(await inspectOrQueueCompletedReview(input, deps)).toMatchObject({ disposition: 'held', reason: change === 'paused' ? 'automatic-retirement-paused' : 'review-obligation-changed' });
    expect(deps.reservation()).toMatchObject({ phase: 'blocked-before-dispatch', taskId: null });
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('keeps uncertain publication owned instead of retrying a potentially committed task', async () => {
    const deps = harness();
    deps.spawn.mockRejectedValue(new Error('response lost after publication'));
    expect(await inspectOrQueueCompletedReview(input, deps)).toMatchObject({ reason: 'cleanup-publication-unverified' });
    for (let i = 0; i < 70; i++) await inspectOrQueueCompletedReview(input, deps);
    expect(deps.spawn).toHaveBeenCalledOnce();
    expect(deps.reservation()).toMatchObject({ phase: 'reserved' });
    expect(deps.lifecycle.recordCleanupOutcome).not.toHaveBeenCalled();
  });

  it('does not reserve when authority is already paused or CI alone is pending', async () => {
    const deps = harness();
    deps.permitted.mockRejectedValue(new Error('automatic-retirement-paused'));
    expect(await inspectOrQueueCompletedReview(input, deps)).toMatchObject({ reason: 'automatic-retirement-paused' });
    expect(deps.lifecycle.reserveRepoCleanupRecovery).not.toHaveBeenCalled();
    const waiting = harness({ ...required(), disposition: 'held', reason: 'review-recorded-handoff-missing' });
    for (let i = 0; i < 70; i++) await inspectOrQueueCompletedReview(input, waiting);
    expect(waiting.spawn).not.toHaveBeenCalled();
    expect(waiting.lifecycle.reserveRepoCleanupRecovery).not.toHaveBeenCalled();
  });

  it('does not launch stale code repair when CI turns green while reservation is persisted', async () => {
    const deps = harness({ ...required(), disposition: 'held', reason: 'review-recorded-handoff-missing' });
    deps.readDelivery = vi.fn(async () => ({ headSha: target.headSha, reason: 'delivery-ci-or-review-pending' }));
    expect(await inspectOrQueueCompletedReview({ ...input, repairEvidence: { head: target.headSha, checks: [{ name: 'CI', conclusion: 'FAILURE' }] } }, deps))
      .toMatchObject({ disposition: 'held', reason: 'review-obligation-changed' });
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(deps.reservation()).toMatchObject({ phase: 'blocked-before-dispatch' });
  });

  it('routes actual same-head CI failure into the configured review loop without changing merge policy', async () => {
    const inspection = { ...required(), disposition: 'held', reason: 'review-not-required', originalTask: { id: 'original', metadata: { prCompletion: 'merge-on-green' } }, roster: { reviewers: [], optionalReviewers: [], usernames: [] } };
    const deps = harness(inspection);
    const repairEvidence = { head: target.headSha, checks: [{ name: 'CI', conclusion: 'FAILURE' }] };
    deps.readDelivery = vi.fn(async () => ({ actionable: true, evidence: repairEvidence }));
    expect(await inspectOrQueueCompletedReview({ ...input, repairEvidence }, deps)).toMatchObject({ reason: 'code-repair-queued' });
    expect(deps.spawn).toHaveBeenCalledWith(expect.objectContaining({ prCompletion: 'merge-on-green', reviewers: [], reviewTarget: target }));
    const changed = harness(inspection);
    await inspectOrQueueCompletedReview({ ...input, repairEvidence: { ...repairEvidence, head: 'b'.repeat(40) } }, changed);
    expect(changed.spawn).not.toHaveBeenCalled();
  });
});
