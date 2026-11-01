import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn() }));

vi.mock('./git.js', () => ({
  resolveForgeForRepo: vi.fn().mockResolvedValue({ cli: 'gh', env: null }),
}));
vi.mock('./github.js', () => ({
  findPullRequestForBranch: vi.fn().mockResolvedValue({ status: 'none', url: null, detail: null }),
  getPullRequestState: vi.fn().mockResolvedValue({ status: 'unavailable', state: null, detail: null }),
}));
const hasQueuedMergeHandoff = vi.hoisted(() => vi.fn());
vi.mock('./cosMergeHandoff.js', () => ({ hasQueuedMergeHandoff }));
vi.mock('./gitlab.js', () => ({
  findMergeRequestForBranch: vi.fn().mockResolvedValue({ status: 'none', url: null, detail: null }),
}));

import { execGit } from '../lib/execGit.js';
import { resolveForgeForRepo } from './git.js';
import { findPullRequestForBranch, getPullRequestState } from './github.js';
import { findMergeRequestForBranch } from './gitlab.js';
import { readMergedPrTip, isMergedPrHead, readMergedPrDelivery, probeChangeRequestState, probePrForBranch } from './prProbe.js';

beforeEach(() => {
  vi.clearAllMocks();
  execGit.mockResolvedValue({ exitCode: 0, stdout: 'published-head\n' });
  resolveForgeForRepo.mockResolvedValue({ cli: 'gh', env: null });
  findPullRequestForBranch.mockResolvedValue({ status: 'none', url: null, detail: null });
  findMergeRequestForBranch.mockResolvedValue({ status: 'none', url: null, detail: null });
  getPullRequestState.mockResolvedValue({ status: 'unavailable', state: null, detail: null });
  hasQueuedMergeHandoff.mockResolvedValue(false);
});

describe('probePrForBranch', () => {
  it('reports readable:true with a live prState when GitHub finds the PR', async () => {
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://example.com/pr/1', number: 1, detail: 'MERGED', headRefOid: 'ABC123' });

    const result = await probePrForBranch('/repo', 'my-branch');

    expect(findPullRequestForBranch).toHaveBeenCalledWith('my-branch', { cwd: '/repo', env: null });
    expect(findMergeRequestForBranch).not.toHaveBeenCalled();
    expect(result).toEqual({ prState: 'MERGED', prUrl: 'https://example.com/pr/1', prNumber: 1, prHead: 'abc123', cli: 'gh', readable: true });
  });

  it('propagates GitHub-confirmed pending auto-merge without claiming MERGED', async () => {
    findPullRequestForBranch.mockResolvedValue({ status: 'found', detail: 'OPEN', autoMergeEnabled: true, headRefOid: 'published-head' });
    expect(await probePrForBranch('/repo', 'my-branch')).toMatchObject({ prState: 'OPEN', readable: true, autoMergeEnabled: true });
  });

  it.each([
    ['unpublished commits', { exitCode: 0, stdout: 'local-only-head\n' }],
    ['missing local branch', { exitCode: 1, stdout: '' }],
    ['unreadable local head', null],
  ])('refuses a remote auto-merge handoff with %s', async (_name, local) => {
    findPullRequestForBranch.mockResolvedValue({ status: 'found', detail: 'OPEN', autoMergeEnabled: true, headRefOid: 'published-head' });
    if (local) execGit.mockResolvedValue(local);
    else execGit.mockRejectedValue(new Error('unreadable'));
    expect(await probePrForBranch('/repo', 'my-branch')).not.toHaveProperty('autoMergeEnabled', true);
  });

  it('reports a pending-merge receipt for the published head without claiming MERGED', async () => {
    const pr = { status: 'found', url: 'https://github.com/example/repo/pull/7', number: 7, detail: 'OPEN', headRefOid: 'published-head' };
    findPullRequestForBranch.mockResolvedValue(pr);
    hasQueuedMergeHandoff.mockResolvedValue(true);
    expect(await probePrForBranch('/repo', 'my-branch')).toMatchObject({ prState: 'OPEN', readable: true, mergeHandoffQueued: true });
    expect(hasQueuedMergeHandoff).toHaveBeenCalledWith({ prUrl: pr.url, prBranch: 'my-branch', headSha: 'published-head' });

    // Local commits the receipt never covered keep the run on recovery.
    hasQueuedMergeHandoff.mockClear();
    execGit.mockResolvedValue({ exitCode: 0, stdout: 'local-only-head\n' });
    expect(await probePrForBranch('/repo', 'my-branch')).not.toHaveProperty('mergeHandoffQueued');
    expect(hasQueuedMergeHandoff).not.toHaveBeenCalled();
  });

  it('uppercases whatever case the forge returned for prState', async () => {
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://example.com/pr/1', number: 1, detail: 'open' });
    const result = await probePrForBranch('/repo', 'my-branch');
    expect(result.prState).toBe('OPEN');
  });

  it('is readable:true with a null prState when the forge found no PR for the branch', async () => {
    const result = await probePrForBranch('/repo', 'my-branch');
    expect(result).toEqual({ prState: null, prUrl: null, prNumber: null, cli: 'gh', readable: true });
  });

  it('is readable:false when the forge call itself fails', async () => {
    findPullRequestForBranch.mockResolvedValue({ status: 'unavailable' });
    const result = await probePrForBranch('/repo', 'my-branch');
    expect(result).toEqual({ prState: null, prUrl: null, prNumber: null, cli: 'gh', readable: false });
  });

  it('is readable:false when no forge CLI could be resolved for the repo', async () => {
    resolveForgeForRepo.mockResolvedValue({ cli: null, env: null });
    const result = await probePrForBranch('/repo', 'my-branch');
    expect(result).toEqual({ prState: null, prUrl: null, prNumber: null, cli: null, readable: false });
    expect(findPullRequestForBranch).not.toHaveBeenCalled();
  });

  it('is readable:false when resolving the forge itself throws', async () => {
    resolveForgeForRepo.mockRejectedValue(new Error('no git remote'));
    const result = await probePrForBranch('/repo', 'my-branch');
    expect(result.readable).toBe(false);
  });

  it('routes to GitLab, with the IID, when the forge is glab', async () => {
    resolveForgeForRepo.mockResolvedValue({ cli: 'glab', env: null });
    findMergeRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://gitlab.example.com/mr/4', number: 4, detail: 'merged' });

    const result = await probePrForBranch('/repo', 'my-branch');

    expect(findMergeRequestForBranch).toHaveBeenCalledWith('my-branch', '/repo');
    expect(findPullRequestForBranch).not.toHaveBeenCalled();
    expect(result).toEqual({ prState: 'MERGED', prUrl: 'https://gitlab.example.com/mr/4', prNumber: 4, prHead: null, cli: 'glab', readable: true });
  });
});

// Authorizes discarding a checkout's uncommitted work, so every non-exact answer is null.
describe('readMergedPrTip', () => {
  it.each([
    ['merged at the local tip', { status: 'found', detail: 'MERGED', headRefOid: 'Published-Head' }, 'published-head'],
    ['merged at an older head', { status: 'found', detail: 'MERGED', headRefOid: 'older-head' }, null],
    ['merged without a head', { status: 'found', detail: 'MERGED' }, null],
    ['still open', { status: 'found', detail: 'OPEN', headRefOid: 'published-head' }, null],
    ['no PR', { status: 'none', detail: null }, null],
    ['unreadable forge', { status: 'unavailable', detail: 'gh failed' }, null],
  ])('answers %s', async (_name, found, expected) => {
    findPullRequestForBranch.mockResolvedValue(found);
    expect(await readMergedPrTip('/repo', 'my-branch')).toBe(expected);
  });

  it('answers null for a missing local branch', async () => {
    execGit.mockResolvedValue({ exitCode: 1, stdout: '' });
    findPullRequestForBranch.mockResolvedValue({ status: 'found', detail: 'MERGED', headRefOid: '' });
    expect(await readMergedPrTip('/repo', 'my-branch')).toBe(null);
  });
});

describe('isMergedPrHead', () => {
  it.each([
    ['merged at the observed head', { status: 'found', detail: 'MERGED', headRefOid: 'ABC' }, 'abc', true],
    ['merged at another head', { status: 'found', detail: 'MERGED', headRefOid: 'older' }, 'abc', false],
    ['still open', { status: 'found', detail: 'OPEN', headRefOid: 'abc' }, 'abc', false],
    ['unreadable forge', { status: 'unavailable', detail: 'gh failed' }, 'abc', false],
    ['no observed head', { status: 'found', detail: 'MERGED', headRefOid: 'abc' }, '', false],
  ])('answers %s', async (_name, found, head, expected) => {
    findPullRequestForBranch.mockResolvedValue(found);
    expect(await isMergedPrHead('/repo', 'my-branch', head)).toBe(expected);
  });

  it('returns the merge time only when that exact head merged, and never invents one', async () => {
    findPullRequestForBranch.mockResolvedValue({ status: 'found', detail: 'MERGED', headRefOid: 'ABC', mergedAt: '2026-10-01T00:00:00.000Z' });
    expect(await readMergedPrDelivery('/repo', 'my-branch', 'abc')).toEqual({ mergedAt: '2026-10-01T00:00:00.000Z' });
    findPullRequestForBranch.mockResolvedValue({ status: 'found', detail: 'MERGED', headRefOid: 'abc' });
    expect(await isMergedPrHead('/repo', 'my-branch', 'abc')).toBe(true);
    expect(await readMergedPrDelivery('/repo', 'my-branch', 'abc')).toBe(null);
  });
});

// A caller that already knows WHICH change request it means (a review-loop
// follow-up carries the number) must not be answered about a different one: a
// reused branch makes the branch lookup's newest PR the wrong PR.
describe('probeChangeRequestState', () => {
  it('asks GitHub by number, bypassing the branch lookup entirely', async () => {
    getPullRequestState.mockResolvedValue({ status: 'known', state: 'MERGED', detail: null });

    const result = await probeChangeRequestState('/repo', { number: 7653, branch: 'claim/issue-7625' });

    expect(getPullRequestState).toHaveBeenCalledWith('7653', { cwd: '/repo', env: null });
    expect(findPullRequestForBranch).not.toHaveBeenCalled();
    expect(result).toEqual({ prState: 'MERGED', cli: 'gh', readable: true });
  });

  it.each([
    ['gh could not answer', { status: 'unavailable', state: null, detail: 'gh failed' }],
    ['gh answered without a state', { status: 'known', state: null, detail: null }],
  ])('reports unreadable — never "not merged" — when %s', async (_label, view) => {
    getPullRequestState.mockResolvedValue(view);
    expect(await probeChangeRequestState('/repo', { number: 7653, branch: 'b' }))
      .toEqual({ prState: null, cli: 'gh', readable: false });
  });

  it('cross-checks the IID on GitLab, where the state is only reachable by branch', async () => {
    resolveForgeForRepo.mockResolvedValue({ cli: 'glab', env: null });
    findMergeRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://example.com/mr/12', number: 12, detail: 'merged' });

    expect(await probeChangeRequestState('/repo', { number: 12, branch: 'feature' }))
      .toEqual({ prState: 'MERGED', cli: 'glab', readable: true });
    // The delegation reuses the forge it already resolved rather than paying for
    // the `gh auth` probe chain twice to answer one question.
    expect(resolveForgeForRepo).toHaveBeenCalledOnce();
    // A different MR on the same source branch answers about the wrong one.
    expect(await probeChangeRequestState('/repo', { number: 13, branch: 'feature' }))
      .toEqual({ prState: null, cli: 'glab', readable: false });
  });

  it('is unreadable with no forge CLI or no number, without calling either forge', async () => {
    resolveForgeForRepo.mockResolvedValue(null);
    expect(await probeChangeRequestState('/repo', { number: 7653, branch: 'b' }))
      .toEqual({ prState: null, cli: null, readable: false });
    resolveForgeForRepo.mockResolvedValue({ cli: 'gh', env: null });
    expect(await probeChangeRequestState('/repo', { number: null, branch: 'b' }))
      .toEqual({ prState: null, cli: null, readable: false });
    expect(getPullRequestState).not.toHaveBeenCalled();
    expect(findMergeRequestForBranch).not.toHaveBeenCalled();
  });
});
