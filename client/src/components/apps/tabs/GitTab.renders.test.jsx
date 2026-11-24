import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

vi.mock('../../../services/apiGit.js', () => ({
  getGitInfo: vi.fn(),
  getBranches: vi.fn(),
  getBranchComparison: vi.fn(),
  getRemoteBranches: vi.fn(),
  stageFiles: vi.fn(),
  createCommit: vi.fn(),
}));
vi.mock('../../ui/Toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('./RepositorySourcePanel', () => ({ default: () => null }));

// Counts every time GitTab renders the history panel. The wrapper is not
// memoized, so it re-renders whenever its parent does — a keystroke that lifts
// into GitTab state shows up here even though the real panel is memoized.
const historyRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('./git/GitHistoryPanel', async () => {
  const actual = await vi.importActual('./git/GitHistoryPanel');
  const Real = actual.default;
  return {
    default: (props) => {
      historyRenders.count += 1;
      return <Real {...props} />;
    },
  };
});

import {
  getGitInfo,
  getBranches,
  getBranchComparison,
  getRemoteBranches,
  stageFiles,
  createCommit,
} from '../../../services/apiGit.js';
import GitTab from './GitTab';

const GIT_INFO = {
  isRepo: true,
  branch: 'main',
  baseBranch: 'main',
  diffStats: { files: 2 },
  status: {
    staged: 1,
    files: [
      { path: 'staged.js', status: 'M', staged: true },
      { path: 'other.js', status: 'M', staged: false },
    ],
  },
  recentCommits: [{ hash: 'abc1234', message: 'earlier work', author: 'Alice', date: '2026-01-02T03:04:05Z' }],
};

beforeEach(() => {
  historyRenders.count = 0;
  getGitInfo.mockResolvedValue(GIT_INFO);
  getBranches.mockResolvedValue({ branches: [] });
  getBranchComparison.mockResolvedValue(null);
  getRemoteBranches.mockResolvedValue({ branches: [], defaultBranch: 'main' });
  stageFiles.mockResolvedValue({ success: true });
  createCommit.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GitTab commit composer isolation', () => {
  it('does not re-render the history panel while the commit message is typed', async () => {
    render(<GitTab appId="app-example" appName="Example App" repoPath="/repo" />);
    const input = await screen.findByRole('textbox', { name: 'Commit message' });
    expect(screen.getByText('earlier work')).toBeInTheDocument();
    const before = historyRenders.count;

    for (const value of ['f', 'fi', 'fix', 'fix t', 'fix the bug']) {
      fireEvent.change(input, { target: { value } });
    }

    expect(input).toHaveValue('fix the bug');
    expect(historyRenders.count).toBe(before);
  });

  it('keeps an unsent message across the reload that staging a file triggers, and clears it after committing', async () => {
    render(<GitTab appId="app-example" appName="Example App" repoPath="/repo" />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Commit message' }), { target: { value: 'wip message' } });

    // Staging reloads git info, which swaps every panel for the spinner and
    // remounts the composer. Hold the reload open so the spinner really commits.
    let finishReload;
    getGitInfo.mockImplementationOnce(() => new Promise((resolve) => { finishReload = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Stage' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Commit message' })).toBeNull());
    await act(async () => finishReload(GIT_INFO));
    expect(await screen.findByRole('textbox', { name: 'Commit message' })).toHaveValue('wip message');

    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(createCommit).toHaveBeenCalledWith('/repo', 'wip message'));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Commit message' })).toHaveValue(''));
  });

  it('keeps the message, re-enables Commit and reloads git status when the commit fails', async () => {
    createCommit.mockRejectedValueOnce(new Error('pre-commit hook failed'));
    render(<GitTab appId="app-example" appName="Example App" repoPath="/repo" />);
    const input = await screen.findByRole('textbox', { name: 'Commit message' });
    fireEvent.change(input, { target: { value: 'keep me' } });
    const loadsBefore = getGitInfo.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(createCommit).toHaveBeenCalledWith('/repo', 'keep me'));
    await waitFor(() => expect(getGitInfo.mock.calls.length).toBeGreaterThan(loadsBefore));

    const after = await screen.findByRole('textbox', { name: 'Commit message' });
    expect(after).toHaveValue('keep me');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit' })).toBeEnabled());
  });
});
