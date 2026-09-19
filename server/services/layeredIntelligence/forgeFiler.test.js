import { describe, it, expect, vi, beforeEach } from 'vitest';

const fileForgeIssueMock = vi.fn();
vi.mock('../appIssues.js', () => ({
  fileForgeIssue: (...args) => fileForgeIssueMock(...args),
  ensureForgeIssueLabels: vi.fn()
}));

import { fileProposalToForge } from './forgeFiler.js';

describe('fileProposalToForge', () => {
  beforeEach(() => vi.clearAllMocks());

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
