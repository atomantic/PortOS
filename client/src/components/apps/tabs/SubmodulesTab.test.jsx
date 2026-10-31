import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockToast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('../../ui/Toast', () => ({ default: mockToast }));

const mockGetSubmodules = vi.fn();
const mockUpdateSubmodule = vi.fn();
vi.mock('../../../services/api', () => ({
  getSubmodules: (...a) => mockGetSubmodules(...a),
  updateSubmodule: (...a) => mockUpdateSubmodule(...a),
}));

const SubmodulesTab = (await import('./SubmodulesTab')).default;

const REPO = '/Users/me/project';
const BEHIND = { name: 'dep', path: 'lib/dep', currentCommit: 'aaaaaaa', latestCommit: 'bbbbbbb', behind: 3, initialized: true };

describe('SubmodulesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSubmodules.mockResolvedValue({ submodules: [BEHIND], defaultBranch: 'trunk' });
    mockUpdateSubmodule.mockResolvedValue({
      success: true, newCommit: 'bbbbbbb', committed: true,
      commitNote: 'committed on trunk', defaultBranch: 'trunk', currentBranch: 'trunk',
    });
  });

  it('scopes the submodule read to the app repo and names its default branch', async () => {
    render(<SubmodulesTab repoPath={REPO} />);

    expect(await screen.findByText('dep')).toBeInTheDocument();
    expect(mockGetSubmodules).toHaveBeenCalledWith(REPO, { silent: true });
    expect(screen.getByText('trunk')).toBeInTheDocument();
  });

  it('updates without a commit by default while the toggle is off', async () => {
    render(<SubmodulesTab repoPath={REPO} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));

    await waitFor(() => expect(mockUpdateSubmodule).toHaveBeenCalled());
    expect(mockUpdateSubmodule).toHaveBeenCalledWith('lib/dep', { repoPath: REPO, commit: false, silent: true });
  });

  it('requests a commit with the update once the toggle is turned on', async () => {
    render(<SubmodulesTab repoPath={REPO} />);
    await screen.findByText('dep');
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(mockUpdateSubmodule).toHaveBeenCalled());
    expect(mockUpdateSubmodule).toHaveBeenCalledWith('lib/dep', { repoPath: REPO, commit: true, silent: true });
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining('committed on trunk')));
  });

  it('reports the server outcome, not the toggle, after an update', async () => {
    mockUpdateSubmodule.mockResolvedValue({
      success: true, newCommit: 'bbbbbbb', committed: false,
      commitSkipped: 'not-on-default-branch',
      commitNote: 'not committed — repo is on feature/wip, not trunk',
      defaultBranch: 'trunk', currentBranch: 'feature/wip',
    });

    render(<SubmodulesTab repoPath={REPO} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining('not committed — repo is on feature/wip')));
  });

  it('disables Update for a submodule that is already current', async () => {
    mockGetSubmodules.mockResolvedValue({ submodules: [{ ...BEHIND, behind: 0 }], defaultBranch: 'trunk' });

    render(<SubmodulesTab repoPath={REPO} />);

    expect(await screen.findByRole('button', { name: 'Update' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Update All/ })).not.toBeInTheDocument();
  });
  it('shows a failed read as an error with Retry, not as a repo without submodules', async () => {
    mockGetSubmodules.mockRejectedValueOnce(new Error('git exited 128'));

    render(<SubmodulesTab repoPath={REPO} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load submodules — git exited 128');
    expect(screen.queryByText(/No git submodules found/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('dep')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the listed submodules when a refresh fails', async () => {
    render(<SubmodulesTab repoPath={REPO} />);
    await screen.findByText('dep');
    mockGetSubmodules.mockRejectedValueOnce(new Error('timeout'));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load submodules');
    expect(screen.getByText('dep')).toBeInTheDocument();
  });
  it('does not keep another repo\'s submodules when the read for a new repo path fails', async () => {
    const { rerender } = render(<SubmodulesTab repoPath={REPO} />);
    await screen.findByText('dep');
    mockGetSubmodules.mockRejectedValueOnce(new Error('not a git repo'));

    rerender(<SubmodulesTab repoPath="/Users/me/other" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load submodules — not a git repo');
    expect(screen.queryByText('dep')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
  });
});
