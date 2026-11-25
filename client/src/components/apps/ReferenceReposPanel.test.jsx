import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  listReferenceRepos: vi.fn(),
  getAppWorkTracker: vi.fn(),
  checkReferenceRepo: vi.fn(),
  updateReferenceRepo: vi.fn(),
  deleteReferenceRepo: vi.fn(),
}));

vi.mock('../../services/apiReferenceRepos.js', () => ({
  listReferenceRepos: api.listReferenceRepos,
  checkReferenceRepo: api.checkReferenceRepo,
  updateReferenceRepo: api.updateReferenceRepo,
  deleteReferenceRepo: api.deleteReferenceRepo,
}));
vi.mock('../../services/apiApps.js', () => ({ getAppWorkTracker: api.getAppWorkTracker }));
vi.mock('../ui/Toast');

import ReferenceReposPanel from './ReferenceReposPanel';

const reference = {
  id: 'ref-1',
  name: 'Example upstream',
  repoUrl: 'https://example.com/upstream.git',
  branch: 'main',
  status: 'stale',
  lastError: 'git fetch failed',
  lastCheckedAt: '2026-08-16T00:00:00.000Z',
  lastReviewedSha: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listReferenceRepos.mockResolvedValue({ referenceRepos: [reference] });
  api.getAppWorkTracker.mockResolvedValue({ resolved: 'github' });
  api.checkReferenceRepo.mockResolvedValue({
    schemaVersion: 1,
    fetchedAt: '2026-08-15T00:00:00.000Z',
    head: 'a'.repeat(40),
    commitCount: 1,
    commits: [{ sha: 'a'.repeat(40), author: 'Alice', date: '2026-08-15T00:00:00.000Z', subject: 'saved commit' }],
    stale: true,
    staleAgeMs: 86_400_000,
    error: { code: 'REFERENCE_REPO_GIT_FAILED', message: 'temporary outage' },
  });
});

afterEach(cleanup);

describe('ReferenceReposPanel stale checks', () => {
  it('renders the stale state and keeps the saved snapshot visibly distinct after a failed check', async () => {
    render(<ReferenceReposPanel appId="app-1" appName="Example App" />);
    expect(await screen.findByText('stale')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /check/i }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(/latest check failed/i);
    expect(notice).toHaveTextContent(/temporary outage/i);
    expect(notice).toHaveTextContent(/1d 0h old/i);
    expect(notice).toHaveTextContent(/retry before marking this reference reviewed/i);
    await waitFor(() => expect(api.checkReferenceRepo).toHaveBeenCalledWith('app-1', 'ref-1', { silent: true }));
  });
});

describe('ReferenceReposPanel mutations apply in place', () => {
  it('applies the saved notes record without re-listing', async () => {
    api.updateReferenceRepo.mockResolvedValue({ ...reference, notes: 'Watch the parser' });
    render(<ReferenceReposPanel appId="app-1" appName="Example App" />);
    await screen.findByText('Example upstream');
    fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
    fireEvent.change(screen.getByLabelText('Repo notes'), { target: { value: 'Watch the parser' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('Repo notes')).toBeNull());
    expect(screen.getByText('Watch the parser')).toBeInTheDocument();
    expect(api.listReferenceRepos).toHaveBeenCalledTimes(1);
  });

  it('confirms removal inline, then drops the row without re-listing', async () => {
    api.deleteReferenceRepo.mockResolvedValue({ ok: true });
    render(<ReferenceReposPanel appId="app-1" appName="Example App" />);
    await screen.findByText('Example upstream');
    fireEvent.click(screen.getByRole('button', { name: 'Remove this reference' }));
    expect(api.deleteReferenceRepo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.deleteReferenceRepo).toHaveBeenCalledWith('app-1', 'ref-1', { silent: true }));
    await waitFor(() => expect(screen.queryByText('Example upstream')).toBeNull());
    expect(api.listReferenceRepos).toHaveBeenCalledTimes(1);
  });
});
