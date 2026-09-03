import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./git.js', () => ({
  resolveForgeForRepo: vi.fn().mockResolvedValue({ cli: 'gh', env: null }),
}));
vi.mock('./github.js', () => ({
  findPullRequestForBranch: vi.fn().mockResolvedValue({ status: 'none', url: null, detail: null }),
}));
vi.mock('./gitlab.js', () => ({
  findMergeRequestForBranch: vi.fn().mockResolvedValue({ status: 'none', url: null, detail: null }),
}));

import { resolveForgeForRepo } from './git.js';
import { findPullRequestForBranch } from './github.js';
import { findMergeRequestForBranch } from './gitlab.js';
import { probePrForBranch } from './prProbe.js';

beforeEach(() => {
  vi.clearAllMocks();
  resolveForgeForRepo.mockResolvedValue({ cli: 'gh', env: null });
  findPullRequestForBranch.mockResolvedValue({ status: 'none', url: null, detail: null });
  findMergeRequestForBranch.mockResolvedValue({ status: 'none', url: null, detail: null });
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
