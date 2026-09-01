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
  resetToDefaultBranch: vi.fn(),
}));
vi.mock('./RepositorySourcePanel', () => ({
  default: ({ appId }) => <div data-testid="repository-source-panel">{appId}</div>,
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
  api.resetToDefaultBranch.mockResolvedValue({ success: true, branch: 'main', previousBranch: 'main', previousHead: 'b'.repeat(40), head: 'a'.repeat(40), discardedFiles: 1, fetched: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GitTab managed repository sources', () => {
  it('shows repository topology for every managed app', async () => {
    const { rerender } = render(
      <GitTab
        appId="app-eidoverse"
        app={{ pm2ProcessNames: ['eidoverse-worlds'] }}
        appName="Eidoverse Worlds"
        repoPath="/repo"
      />,
    );

    expect(await screen.findByTestId('repository-source-panel')).toHaveTextContent('app-eidoverse');

    rerender(
      <GitTab
        appId="app-other"
        app={{ pm2ProcessNames: ['example-app'] }}
        appName="Example App"
        repoPath="/repo"
      />,
    );
    expect(screen.getByTestId('repository-source-panel')).toHaveTextContent('app-other');
  });
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

describe('GitTab merged branches checked out in worktrees', () => {
  beforeEach(() => {
    // Both merged branches are checked out in worktrees, so the cleanup action
    // remains visible while disclosing that the server will preserve them.
    api.getBranches.mockResolvedValue({
      branches: [
        { name: 'main', current: true, tracking: 'origin/main', ahead: 0, behind: 0, isDefault: true, merged: false, worktree: false },
        { name: 'claim/issue-1', current: false, tracking: null, ahead: 0, behind: 0, isDefault: false, merged: true, worktree: true },
        { name: 'claim/issue-2', current: false, tracking: null, ahead: 0, behind: 0, isDefault: false, merged: true, worktree: true },
      ],
    });
    api.getRemoteBranches.mockResolvedValue({ branches: [], defaultBranch: 'main' });
  });

  it('keeps the local cleanup button visible and discloses worktree-held branches', async () => {
    render(<GitTab appId="x" appName="App" repoPath="/repo" />);

    // The merged branches still render (with their badges) so the user can see them.
    expect(await screen.findByText('claim/issue-1')).toBeInTheDocument();
    const localCleanBtn = screen.getByRole('button', { name: 'Clean 2 merged' });
    expect(localCleanBtn).toHaveAttribute('title', 'Cleans merged branches when safe; 2 merged branches checked out in a worktree will be preserved');
    expect(screen.getByRole('status')).toHaveTextContent('2 merged branches in a worktree will be preserved');
  });

  it('uses an eligible-only confirmation when merged branches are held in worktrees', async () => {
    render(<GitTab appId="x" appName="App" repoPath="/repo" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Clean 2 merged' }));

    expect(await screen.findByRole('button', { name: 'Delete eligible merged (local + remote)' })).toHaveAttribute(
      'title',
      'Cleans merged branches when safe; 2 merged branches checked out in a worktree will be preserved'
    );
  });

  it('labels worktree-checked-out branches with a worktree badge', async () => {
    render(<GitTab appId="x" appName="App" repoPath="/repo" />);

    await screen.findByText('claim/issue-1');
    expect(screen.getAllByText('worktree')).toHaveLength(2);
  });
});

describe('GitTab reset to origin', () => {
  it('confirms before resetting, and names what is discarded and what survives', async () => {
    render(<GitTab appId="x" appName="App" repoPath="/repo" />);

    fireEvent.click(await screen.findByText('Reset to origin'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-labelledby', 'git-reset-modal-title');
    expect(document.getElementById('git-reset-modal-title')).toHaveTextContent('Reset App to origin/main');
    // Scope is stated, not implied: one dirty file in GIT_INFO, untracked kept.
    expect(dialog).toHaveTextContent('Discards 1 uncommitted file change');
    expect(dialog).toHaveTextContent('Keeps untracked files');
    // Opening the dialog alone must not touch the repo.
    expect(api.resetToDefaultBranch).not.toHaveBeenCalled();
  });

  it('does not count untracked files among what it says it will discard', async () => {
    // The dialog promises "Keeps untracked files" two rows below this number,
    // so counting them there contradicts the same dialog.
    api.getGitInfo.mockResolvedValue({
      ...GIT_INFO,
      status: {
        files: [
          { path: 'a.js', status: 'modified', staged: false },
          { path: 'b.js', status: 'added', staged: true },
          { path: 'scratch.log', status: 'untracked', staged: false },
        ],
      },
    });
    render(<GitTab appId="x" appName="App" repoPath="/repo" />);

    fireEvent.click(await screen.findByText('Reset to origin'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Discards 2 uncommitted file changes');
  });

  it('does not reset when the confirmation is cancelled', async () => {
    render(<GitTab appId="x" appName="App" repoPath="/repo" />);

    fireEvent.click(await screen.findByText('Reset to origin'));
    fireEvent.click(await screen.findByText('Cancel'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.resetToDefaultBranch).not.toHaveBeenCalled();
  });

  it('refreshes the dirty-file count when the dialog opens', async () => {
    render(<GitTab appId="x" appName="App" repoPath="/repo" />);
    await screen.findByText('Reset to origin');
    const onMount = api.getGitInfo.mock.calls.length;

    fireEvent.click(screen.getByText('Reset to origin'));

    // The dialog names how many files it will destroy, so it must not quote a
    // count from whenever the tab last polled.
    await waitFor(() => expect(api.getGitInfo.mock.calls.length).toBeGreaterThan(onMount));
  });

  it('resets on confirm and reloads git state', async () => {
    render(<GitTab appId="x" appName="App" repoPath="/repo" />);

    fireEvent.click(await screen.findByText('Reset to origin'));
    await screen.findByRole('dialog');
    const beforeConfirm = api.getGitInfo.mock.calls.length;

    fireEvent.click(screen.getByText('Discard and reset'));

    await waitFor(() => expect(api.resetToDefaultBranch).toHaveBeenCalledWith('/repo', { silent: true }));
    // The tab re-reads git state rather than trusting its pre-reset snapshot.
    await waitFor(() => expect(api.getGitInfo.mock.calls.length).toBeGreaterThan(beforeConfirm));
  });
});
