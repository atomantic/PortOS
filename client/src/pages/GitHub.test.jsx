import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const mock = vi.hoisted(() => ({
  getGitHubRepos: vi.fn(),
  getGitHubSecrets: vi.fn(),
  getGitHubStatus: vi.fn(),
  syncGitHubRepos: vi.fn(),
  updateGitHubRepo: vi.fn(),
  setGitHubSecret: vi.fn(),
  syncGitHubSecret: vi.fn(),
  archiveGitHubRepo: vi.fn(),
  unarchiveGitHubRepo: vi.fn(),
  getGitHubAccounts: vi.fn(),
  createGitHubAccount: vi.fn(),
  updateGitHubAccount: vi.fn(),
  deleteGitHubAccount: vi.fn(),
  getGitHubAccountStatus: vi.fn(),
}));

vi.mock('../services/api', () => mock);

import GitHub from './GitHub';

describe('GitHub account setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getGitHubRepos.mockResolvedValue({});
    mock.getGitHubSecrets.mockResolvedValue({});
    mock.getGitHubStatus.mockResolvedValue({
      authenticated: false,
      status: 'not-authenticated',
      login: null,
      remedy: 'Run `gh auth login`.',
      githubUser: null,
      lastRepoSync: null,
    });
  });

  it('distinguishes a failed repository read from a successful empty response', async () => {
    mock.getGitHubRepos.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
    render(
      <MemoryRouter initialEntries={['/devtools/github']}>
        <GitHub />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Could not load GitHub repositories.')).toBeInTheDocument();
    expect(screen.queryByText('No repos loaded yet.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No repos loaded yet.')).toBeInTheDocument();
  });

  it('offers an in-app GitHub login flow and prevents an anonymous repo sync', async () => {
    render(
      <MemoryRouter initialEntries={['/devtools/github']}>
        <GitHub />
      </MemoryRouter>,
    );

    const signIn = await screen.findByRole('link', { name: 'Sign in with GitHub' });
    expect(decodeURIComponent(signIn.getAttribute('href'))).toContain('/shell?cmd=gh auth login');
    expect(screen.getByRole('button', { name: 'Sync Repos' })).toBeDisabled();
  });

  it('describes a signed-out legacy cache without rendering a null account', async () => {
    mock.getGitHubStatus.mockResolvedValue({
      authenticated: false,
      status: 'not-authenticated',
      login: null,
      credentialSource: 'cli',
      remedy: 'Run `gh auth login`.',
      githubUser: 'legacy-owner',
      lastRepoSync: null,
    });

    render(
      <MemoryRouter initialEntries={['/devtools/github']}>
        <GitHub />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/cached from @legacy-owner/i)).toHaveTextContent(
      'Sign in and sync to replace them',
    );
    expect(screen.queryByText(/@null/)).toBeNull();
  });

  it('shows the active account and enables repo sync when gh is authenticated', async () => {
    mock.getGitHubStatus.mockResolvedValue({
      authenticated: true,
      status: 'ok',
      login: 'example-user',
      remedy: null,
      githubUser: 'example-user',
      lastRepoSync: null,
    });

    render(
      <MemoryRouter initialEntries={['/devtools/github']}>
        <GitHub />
      </MemoryRouter>,
    );

    expect(await screen.findByLabelText('GitHub account @example-user')).toBeTruthy();
    expect(screen.queryByText('GitHub connected')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sync Repos' })).not.toBeDisabled();
    fireEvent.click(screen.getByLabelText('GitHub account @example-user'));
    expect(screen.getByRole('link', { name: 'Add GitHub account' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Switch GitHub account' })).toBeTruthy();
  });

  it('explains that an environment token overrides stored CLI accounts', async () => {
    mock.getGitHubStatus.mockResolvedValue({
      authenticated: true,
      status: 'ok',
      login: 'example-user',
      credentialSource: 'env',
      remedy: null,
      githubUser: 'example-user',
      lastRepoSync: null,
    });

    render(
      <MemoryRouter initialEntries={['/devtools/github']}>
        <GitHub />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/environment credentials override stored gh accounts/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /GitHub account/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sync Repos' })).not.toBeDisabled();
  });

  it('does not offer a CLI login that an invalid environment token would override', async () => {
    mock.getGitHubStatus.mockResolvedValue({
      authenticated: false,
      status: 'not-authenticated',
      login: null,
      credentialSource: 'env',
      remedy: 'GH_TOKEN or GITHUB_TOKEN is set but GitHub rejected it.',
      githubUser: null,
      lastRepoSync: null,
    });

    render(
      <MemoryRouter initialEntries={['/devtools/github']}>
        <GitHub />
      </MemoryRouter>,
    );

    expect(await screen.findByText('GitHub environment credential rejected')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Sign in with GitHub' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sync Repos' })).toBeDisabled();
  });

  it('distinguishes an unavailable status check from signed out and disables sync', async () => {
    mock.getGitHubStatus.mockRejectedValue(new Error('status unavailable'));

    render(
      <MemoryRouter initialEntries={['/devtools/github']}>
        <GitHub />
      </MemoryRouter>,
    );

    expect(await screen.findByText('GitHub status unavailable')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Sign in with GitHub' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sync Repos' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('retries an unavailable authentication check in place', async () => {
    mock.getGitHubStatus
      .mockRejectedValueOnce(new Error('status unavailable'))
      .mockResolvedValueOnce({
        authenticated: true,
        status: 'ok',
        login: 'example-user',
        githubUser: 'example-user',
        lastRepoSync: null,
      });

    render(
      <MemoryRouter initialEntries={['/devtools/github']}>
        <GitHub />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('@example-user')).toBeTruthy();
    expect(mock.getGitHubStatus).toHaveBeenCalledTimes(2);
  });

  it('warns when GitHub reaches the repository listing limit', async () => {
    mock.getGitHubStatus.mockResolvedValue({
      authenticated: true,
      status: 'ok',
      login: 'example-user',
      githubUser: 'example-user',
      lastRepoSync: null,
    });
    mock.syncGitHubRepos.mockResolvedValue({
      repos: {},
      githubUser: 'example-user',
      lastRepoSync: '2026-01-01T00:00:00.000Z',
      truncated: true,
    });

    render(
      <MemoryRouter initialEntries={['/devtools/github']}>
        <GitHub />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Sync Repos' }));
    expect(await screen.findByText(/200-repository limit/i)).toBeTruthy();
  });

  it('does not mislabel a GitHub network failure as signed out', async () => {
    mock.getGitHubStatus.mockResolvedValue({
      authenticated: false,
      status: 'unreachable',
      login: null,
      credentialSource: 'cli',
      remedy: 'GitHub is unreachable.',
      githubUser: null,
      lastRepoSync: null,
    });

    render(
      <MemoryRouter initialEntries={['/devtools/github']}>
        <GitHub />
      </MemoryRouter>,
    );

    expect(await screen.findByText('GitHub status unavailable')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Sign in with GitHub' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sync Repos' })).toBeDisabled();
  });

  it('shows an install state instead of offering login when the GitHub CLI is missing', async () => {
    mock.getGitHubStatus.mockResolvedValue({
      authenticated: false,
      status: 'not-installed',
      login: null,
      credentialSource: 'cli',
      remedy: 'Install the GitHub CLI.',
      githubUser: null,
      lastRepoSync: null,
    });

    render(
      <MemoryRouter initialEntries={['/devtools/github']}>
        <GitHub />
      </MemoryRouter>,
    );

    expect(await screen.findByText('GitHub CLI required')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Sign in with GitHub' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sync Repos' })).toBeDisabled();
  });

  it('blocks cached-repository actions until the newly active account is synced', async () => {
    mock.getGitHubRepos.mockResolvedValue({
      'legacy-owner/old-repo': {
        name: 'old-repo',
        fullName: 'legacy-owner/old-repo',
        description: '',
        isArchived: false,
        pushedAt: null,
        flags: { npmProject: false },
        managedSecrets: ['EXAMPLE_SECRET'],
      },
    });
    mock.getGitHubSecrets.mockResolvedValue({
      EXAMPLE_SECRET: { hasValue: true, updatedAt: null },
    });
    mock.getGitHubStatus.mockResolvedValue({
      authenticated: true,
      status: 'ok',
      login: 'example-user',
      remedy: null,
      githubUser: 'legacy-owner',
      lastRepoSync: null,
    });

    render(
      <MemoryRouter initialEntries={['/devtools/github']}>
        <GitHub />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/cached from @legacy-owner/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'NPM' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sync to Repos' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sync Repos' })).not.toBeDisabled();
  });
});

const renderAccounts = () => render(
  <MemoryRouter initialEntries={['/devtools/github/accounts']}>
    <Routes>
      <Route path="/devtools/github/:tab" element={<GitHub />} />
    </Routes>
  </MemoryRouter>,
);

const IMPLICIT = {
  id: 'github-com', label: 'github.com', host: 'github.com', login: null,
  trust: 'public', allowedProviders: null, mode: 'observe', enabled: true, implicit: true,
};

describe('GitHub accounts tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getGitHubAccounts.mockResolvedValue([IMPLICIT]);
    mock.getGitHubAccountStatus.mockResolvedValue({ id: 'github-com', host: 'github.com', status: 'ok', login: 'octocat', remedy: null, command: null });
  });

  it('lists each account with its trust level and live sign-in state', async () => {
    renderAccounts();
    expect(await screen.findByText('Signed in')).toBeTruthy();
    expect(screen.getByText('@octocat')).toBeTruthy();
    expect(screen.getByText('Public')).toBeTruthy();
    expect(screen.getByText('Observe')).toBeTruthy();
    expect(mock.getGitHubRepos).not.toHaveBeenCalled();
  });

  it('adds an Enterprise account as Private by default and offers its sign-in command', async () => {
    mock.createGitHubAccount.mockImplementation(async (body) => ({
      ...body, id: 'acct-2', label: 'alice @ ghe.example.com', mode: 'observe', enabled: true, allowedProviders: null,
    }));
    mock.getGitHubAccountStatus.mockImplementation(async (id) => (id === 'acct-2'
      ? { id, host: 'ghe.example.com', status: 'not-authenticated', login: null, remedy: 'Sign in.', command: 'gh auth login --hostname ghe.example.com --web --clipboard' }
      : { id, host: 'github.com', status: 'ok', login: 'octocat', remedy: null, command: null }));
    renderAccounts();

    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'ghe.example.com' } });
    fireEvent.change(screen.getByLabelText('Login'), { target: { value: 'alice' } });
    expect(screen.getByLabelText('Trust').value).toBe('private');
    fireEvent.click(screen.getAllByRole('button', { name: 'Add account' }).at(-1));

    expect(mock.createGitHubAccount).toHaveBeenCalledWith({ host: 'ghe.example.com', login: 'alice', label: '', trust: 'private' });
    const signIn = await screen.findByRole('link', { name: 'Sign in on ghe.example.com' });
    expect(decodeURIComponent(signIn.getAttribute('href'))).toBe('/shell?cmd=gh auth login --hostname ghe.example.com --web --clipboard');
  });

  it('removes an account only after an inline confirmation', async () => {
    mock.deleteGitHubAccount.mockResolvedValue({ id: 'github-com' });
    renderAccounts();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(mock.deleteGitHubAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(mock.deleteGitHubAccount).toHaveBeenCalledWith('github-com');
    expect(await screen.findByText('No GitHub accounts yet.')).toBeTruthy();
  });
});
