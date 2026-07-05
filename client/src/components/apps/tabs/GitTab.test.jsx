import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Mock the API surface GitTab calls on mount + when opening the diff modal.
vi.mock('../../../services/api', () => ({
  getGitInfo: vi.fn(),
  getBranches: vi.fn(),
  getBranchComparison: vi.fn(),
  getRemoteBranches: vi.fn(),
  getGitDiff: vi.fn(),
  cleanupMergedBranches: vi.fn(),
}));

import * as api from '../../../services/api';
import GitTab from './GitTab';

const GIT_INFO = {
  isRepo: true,
  branch: 'dev',
  baseBranch: 'main',
  devBranch: 'dev',
  diffStats: { files: 1 },
  status: { files: [{ path: 'a.js', status: 'M', staged: false }] },
};

const COMPARISON = {
  ahead: 2,
  stats: { insertions: 10, deletions: 3, files: 1 },
  commits: [{ hash: 'abc1234', message: 'do a thing' }],
};

beforeEach(() => {
  api.getGitInfo.mockResolvedValue(GIT_INFO);
  api.getBranches.mockResolvedValue({ branches: [] });
  api.getBranchComparison.mockResolvedValue(COMPARISON);
  api.getRemoteBranches.mockResolvedValue({ branches: [], defaultBranch: 'main' });
  api.getGitDiff.mockResolvedValue({ diff: '@@ -1 +1 @@\n-old\n+new' });
  api.cleanupMergedBranches.mockResolvedValue({ deleted: [], skipped: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GitTab modal accessibility (issue #1090)', () => {
  it('opens the diff as a labeled dialog with a labeled close button', async () => {
    render(<GitTab appId="x" appName="App" repoPath="/repo" />);

    const viewDiff = await screen.findByText('View Diff');
    fireEvent.click(viewDiff);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'git-diff-modal-title');
    // The labelling target is rendered inside the dialog.
    expect(document.getElementById('git-diff-modal-title')).toHaveTextContent('Git Diff');
    // Backdrop is presentation-only.
    expect(dialog.parentElement).toHaveAttribute('role', 'presentation');
    // Close affordance carries an accessible name.
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('closes the diff dialog on Escape', async () => {
    render(<GitTab appId="x" appName="App" repoPath="/repo" />);
    fireEvent.click(await screen.findByText('View Diff'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens the release confirmation as a labeled dialog', async () => {
    render(<GitTab appId="x" appName="App" repoPath="/repo" />);

    const releaseBtn = await screen.findByText('Create Release PR');
    fireEvent.click(releaseBtn);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'git-release-modal-title');
    expect(document.getElementById('git-release-modal-title')).toHaveTextContent('Create Release PR for App');
    expect(dialog.parentElement).toHaveAttribute('role', 'presentation');
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});

describe('GitTab merged-branch cleanup scoping', () => {
  beforeEach(() => {
    api.getBranches.mockResolvedValue({
      branches: [
        { name: 'main', current: true, tracking: 'origin/main', ahead: 0, behind: 0, isDefault: true, merged: false },
        { name: 'feature/done', current: false, tracking: 'origin/feature/done', ahead: 0, behind: 0, isDefault: false, merged: true },
      ],
    });
    api.getRemoteBranches.mockResolvedValue({
      branches: [
        { name: 'main', fullRef: 'origin/main', merged: false, hasLocal: true, isDefault: true },
        { name: 'old/one', fullRef: 'origin/old/one', merged: true, hasLocal: false, isDefault: false },
        { name: 'old/two', fullRef: 'origin/old/two', merged: true, hasLocal: false, isDefault: false },
      ],
      defaultBranch: 'main',
    });
  });

  it('shows only the local confirm block when the Local panel button is clicked, and discloses full local+remote scope', async () => {
    render(<GitTab appId="x" appName="App" repoPath="/repo" />);

    const localCleanBtn = await screen.findByText('Clean 1 merged');
    fireEvent.click(localCleanBtn);

    const confirmButtons = await screen.findAllByText('Delete all merged (local + remote)');
    expect(confirmButtons).toHaveLength(1);
    expect(confirmButtons[0]).toHaveAttribute('title', 'Deletes merged branches both locally and on the remote');

    // The Remote panel's own trigger is hidden while the Local panel's confirm is active,
    // and it must not render its own confirm block at the same time.
    expect(screen.queryByText('Clean 2 merged')).toBeNull();
  });
});
