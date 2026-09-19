import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./git.js', () => ({
  resolveForgeForRepo: vi.fn().mockResolvedValue({ cli: 'gh', env: null }),
}));
vi.mock('./github.js', () => ({
  findPullRequestForBranch: vi.fn().mockResolvedValue({ status: 'none', url: null, detail: null }),
  getPullRequestState: vi.fn().mockResolvedValue({ status: 'unavailable', state: null, detail: null }),
}));
vi.mock('./gitlab.js', () => ({
  findMergeRequestForBranch: vi.fn().mockResolvedValue({ status: 'none', url: null, detail: null }),
}));

import { resolveForgeForRepo } from './git.js';
import { findPullRequestForBranch, getPullRequestState } from './github.js';
import { findMergeRequestForBranch } from './gitlab.js';
import { probeChangeRequestState, probePrForBranch } from './prProbe.js';

beforeEach(() => {
  vi.clearAllMocks();
  resolveForgeForRepo.mockResolvedValue({ cli: 'gh', env: null });
  findPullRequestForBranch.mockResolvedValue({ status: 'none', url: null, detail: null });
  findMergeRequestForBranch.mockResolvedValue({ status: 'none', url: null, detail: null });
  getPullRequestState.mockResolvedValue({ status: 'unavailable', state: null, detail: null });
});

describe('probePrForBranch', () => {
  it('reports readable:true with a live prState when GitHub finds the PR', async () => {
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://example.com/pr/1', number: 1, detail: 'MERGED' });

    const result = await probePrForBranch('/repo', 'my-branch');

    expect(findPullRequestForBranch).toHaveBeenCalledWith('my-branch', { cwd: '/repo', env: null });
    expect(findMergeRequestForBranch).not.toHaveBeenCalled();
    expect(result).toEqual({ prState: 'MERGED', prUrl: 'https://example.com/pr/1', prNumber: 1, cli: 'gh', readable: true });
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
    expect(result).toEqual({ prState: 'MERGED', prUrl: 'https://gitlab.example.com/mr/4', prNumber: 4, cli: 'glab', readable: true });
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
