import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  applyGitHubAuditSuggestion: vi.fn(),
  getGitHubAccounts: vi.fn(),
  getGitHubAudit: vi.fn(),
  getGitHubAuditChanges: vi.fn(),
  runGitHubAudit: vi.fn(),
  undoGitHubAuditChange: vi.fn(),
  updateGitHubAccount: vi.fn(),
}));

vi.mock('../../services/api', () => api);

const GitHubAuditTab = (await import('./GitHubAuditTab')).default;

const account = { id: 'acct-1', label: 'Work', auditReport: false };
const audit = {
  windowDays: 30, ranAt: new Date().toISOString(), watchedListed: true,
  summary: { total: 12, repos: 3, acted: 4, handled: 2 }, suggestions: [],
};
const change = {
  id: 7, kind: 'unwatch', repo: 'example/noisy', threadCount: null, accountLabel: 'Work', appliedAt: new Date().toISOString(), undone: false,
};

const renderTab = () => render(<MemoryRouter><GitHubAuditTab /></MemoryRouter>);

describe('GitHubAuditTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getGitHubAccounts.mockResolvedValue([account]);
  });

  it('shows a failed applied-changes read as an error with Retry, keeping Undo reachable', async () => {
    api.getGitHubAudit.mockResolvedValue({ audit: null });
    api.getGitHubAuditChanges.mockRejectedValueOnce(new Error('offline'));
    renderTab();

    expect(await screen.findByText(/Could not load applied changes/)).toBeTruthy();
    expect(screen.queryByText('None yet.')).toBeNull();

    api.getGitHubAuditChanges.mockResolvedValue({ changes: [change] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('example/noisy')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Undo/ })).toBeTruthy();
    expect(screen.queryByText(/Could not load applied changes/)).toBeNull();
  });

  it('shows a failed stored-audit read as an error with Retry, not as "no audit yet"', async () => {
    api.getGitHubAuditChanges.mockResolvedValue({ changes: [] });
    api.getGitHubAudit.mockRejectedValueOnce(new Error('offline'));
    renderTab();

    expect(await screen.findByText(/Could not load the last audit/)).toBeTruthy();
    expect(screen.queryByText(/Nothing changes until you tap Apply/)).toBeNull();

    api.getGitHubAudit.mockResolvedValue({ audit });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText(/12 notifications in 3 repos/)).toBeTruthy();
    expect(screen.queryByText(/Could not load the last audit/)).toBeNull();
  });
});
