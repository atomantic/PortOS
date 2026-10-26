import { describe, it, expect, vi, beforeEach } from 'vitest';

const fileForgeIssueMock = vi.fn();
vi.mock('../appIssues.js', () => ({
  fileForgeIssue: (...args) => fileForgeIssueMock(...args),
  ensureForgeIssueLabels: vi.fn()
}));

import { fileProposalToForge } from './forgeFiler.js';
import { validateReasonerResponse } from './proposal.js';

describe('fileProposalToForge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('carries actual combined prerequisites from reasoner output into unscoped GitLab labels', async () => {
    fileForgeIssueMock.mockResolvedValue({ ok: true, number: 9, url: 'https://example.test/issues/9' });
    const { proposal } = validateReasonerResponse({ proposal: {
      scope: 'app-improvement', slug: 'cuda-proof', title: 'Validate CUDA output',
      model: 'medium', effort: 'high', helpWanted: true,
      hardwareRequirements: ['windows', 'cuda', 'cuda'],
    } });
    expect((await fileProposalToForge({ ...proposal, cli: 'glab' })).success).toBe(true);
    expect(fileForgeIssueMock.mock.calls[0][0].labels).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'model::medium' }),
      expect.objectContaining({ name: 'windows', description: 'Requires Windows development or validation' }),
      expect.objectContaining({ name: 'cuda', description: 'Requires NVIDIA CUDA hardware' }),
    ]));
    expect(fileForgeIssueMock.mock.calls[0][0].labels.filter(({ name }) => name === 'cuda')).toHaveLength(1);
  });

  it.each(['user-perspectives', 'hardware-alternatives'])('files %s help wanted without deriving requirements from incidental platform text', async (helpWantedReason) => {
    fileForgeIssueMock.mockResolvedValue({ ok: true, number: 9 });
    const { proposal } = validateReasonerResponse({ proposal: {
      scope: 'app-improvement', slug: 'perspectives', title: 'Gather user perspectives',
      body: 'Compare feedback; Windows, macOS and CUDA are background examples only.',
      model: 'medium', effort: 'low', helpWanted: true, helpWantedReason,
    } });
    expect((await fileProposalToForge({ ...proposal, cli: 'gh' })).success).toBe(true);
    expect(fileForgeIssueMock.mock.calls[0][0].labels.map(({ name }) => name))
      .toEqual(['layered-intelligence', 'model:medium', 'effort:low', 'help wanted']);
  });

  it.each([
    undefined, null, 'cuda', ['CUDA'], ['cuda', 42], ['macos', 'cuda'], ['windows', 'linux'],
  ])('refuses missing, malformed or mixed hardware requirements %j before filing', async (hardwareRequirements) => {
    const input = {
      scope: 'app-improvement', slug: 'proof', title: 'Validate output',
      model: 'medium', effort: 'high', helpWanted: true, hardwareRequirements,
    };
    const response = validateReasonerResponse({ proposal: input });
    expect(response.proposal).toBeNull();
    expect(response.invalidFields).toEqual(['proposal']);
    expect((await fileProposalToForge({ ...input, cli: 'gh' })).success).toBe(false);
    expect(fileForgeIssueMock).not.toHaveBeenCalled();
  });

  it('forwards the GitHub API host so the shared filer can probe before exec', async () => {
    fileForgeIssueMock.mockResolvedValue({ ok: false, error: 'GitHub is not reachable (unreachable)' });
    const exec = vi.fn();

    const result = await fileProposalToForge({
      cli: 'gh', hostname: 'api.github.example', cwd: '/repo', title: 'T', body: 'B', slug: 's',
      model: 'light', effort: 'medium', exec
    });

    expect(result).toEqual({ success: false, error: expect.stringContaining('GitHub is not reachable') });
    expect(fileForgeIssueMock).toHaveBeenCalledWith(expect.objectContaining({
      cli: 'gh', hostname: 'api.github.example', exec
    }));
    expect(exec).not.toHaveBeenCalled();
  });
});
