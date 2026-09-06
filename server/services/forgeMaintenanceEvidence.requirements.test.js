import { describe, expect, it, vi } from 'vitest';
import { loadTrustedIssueEvidence } from './forgeMaintenanceEvidence.js';

const setup = () => {
  const pullRequest = {
    number: 8, state: 'closed', merged: true, merge_commit_sha: 'a'.repeat(40),
    user: { login: 'outside-contributor' }, title: 'External PR title', body: 'External PR description',
    base: { ref: 'main', repo: { full_name: 'example/project' } },
  };
  return { pullRequest, options: {
    record: { number: 7, mergedPr: { number: 8 } },
    item: { title: 'Fix import error', body: 'The empty import must complete without crashing.', user: { login: 'maintainer' } },
    repoFullName: 'example/project',
    trust: { isTrusted: vi.fn(async login => login === 'maintainer') },
    read: vi.fn(async endpoint => endpoint.endsWith('/pulls/8') ? pullRequest : { default_branch: 'main' }),
  } };
};

describe('trusted requirements and accepted merge evidence', () => {
  it('carries trusted requirements and the accepted commit without promoting external PR prose', async () => {
    const { options } = setup();
    expect(await loadTrustedIssueEvidence(options)).toEqual({ ok: true, evidence: {
      title: options.item.title, body: options.item.body,
      mergedPrNumber: 8, mergeCommitSha: 'a'.repeat(40), baseBranch: 'main',
    } });
    expect(options.trust.isTrusted).toHaveBeenCalledWith('maintainer');
    expect(options.read).toHaveBeenCalledWith('repos/example/project');
  });

  it('rejects unmerged, wrong-base, wrong-repository or incomplete merge identities', async () => {
    for (const invalid of [
      { merged: false }, { state: 'open' }, { merge_commit_sha: null },
      { base: { ref: 'release', repo: { full_name: 'example/project' } } },
      { base: { ref: 'main', repo: { full_name: 'outside/project' } } },
    ]) {
      const { options, pullRequest } = setup();
      Object.assign(pullRequest, invalid);
      expect(await loadTrustedIssueEvidence(options)).toEqual({ ok: false, code: 'maintenance-merged-change-unverified' });
    }
  });

  it('rejects changed issue authority before fetching merged evidence', async () => {
    const { options } = setup();
    options.trust.isTrusted.mockResolvedValue(false);
    expect(await loadTrustedIssueEvidence(options)).toEqual({ ok: false, code: 'maintenance-requirements-unavailable' });
    expect(options.read).not.toHaveBeenCalled();
  });
});
