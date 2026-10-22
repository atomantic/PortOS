import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  getGitHubNotifications: vi.fn(),
  syncGitHubNotifications: vi.fn(),
  applyGitHubNotificationAction: vi.fn(),
  getGitHubNotification: vi.fn(),
  getGitHubAutomations: vi.fn(),
  setGitHubNotificationCadence: vi.fn(),
  getGitHubAutomationActivity: vi.fn(),
  undoGitHubAutomationAction: vi.fn(),
  getGitHubLearnedRules: vi.fn(),
  deleteGitHubLearnedRule: vi.fn(),
  getProviders: vi.fn(),
  getGitHubAudit: vi.fn(),
  runGitHubAudit: vi.fn(),
  applyGitHubAuditSuggestion: vi.fn(),
  getGitHubAuditChanges: vi.fn(),
  undoGitHubAuditChange: vi.fn(),
}));

vi.mock('../services/api', () => mock);

vi.mock('../services/socket', () => {
  const listeners = new Map();
  return { default: {
    on: vi.fn((event, handler) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
    }),
    off: vi.fn((event, handler) => listeners.get(event)?.delete(handler)),
    emit: (event, payload) => listeners.get(event)?.forEach((handler) => handler(payload)),
  } };
});
import socket from '../services/socket';

import GitHub from './GitHub';

const renderTab = (tab) => render(
  <MemoryRouter initialEntries={[`/devtools/github/${tab}`]}>
    <Routes>
      <Route path="/devtools/github" element={<GitHub />} />
      <Route path="/devtools/github/:tab" element={<GitHub />} />
      <Route path="/devtools/github/:tab/:accountId/:threadId" element={<GitHub />} />
    </Routes>
  </MemoryRouter>,
);

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
    renderTab('repos');

    expect(await screen.findByText('Could not load GitHub repositories.')).toBeInTheDocument();
    expect(screen.queryByText('No repos loaded yet.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No repos loaded yet.')).toBeInTheDocument();
  });

  it('offers an in-app GitHub login flow and prevents an anonymous repo sync', async () => {
    renderTab('repos');

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

    renderTab('repos');

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

    renderTab('repos');

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

    renderTab('repos');

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

    renderTab('repos');

    expect(await screen.findByText('GitHub environment credential rejected')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Sign in with GitHub' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sync Repos' })).toBeDisabled();
  });

  it('distinguishes an unavailable status check from signed out and disables sync', async () => {
    mock.getGitHubStatus.mockRejectedValue(new Error('status unavailable'));

    renderTab('repos');

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

    renderTab('repos');

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

    renderTab('repos');

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

    renderTab('repos');

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

    renderTab('repos');

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

    renderTab('repos');

    expect(await screen.findByText(/cached from @legacy-owner/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'NPM' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sync to Repos' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sync Repos' })).not.toBeDisabled();
  });
});

const renderAccounts = () => renderTab('accounts');

const IMPLICIT = {
  id: 'github-com', label: 'github.com', host: 'github.com', login: null,
  trust: 'public', allowedProviders: null, mode: 'observe', enabled: true, implicit: true,
};

describe('GitHub accounts tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getGitHubAccounts.mockResolvedValue([IMPLICIT]);
    mock.getGitHubAccountStatus.mockResolvedValue({ id: 'github-com', host: 'github.com', status: 'ok', login: 'octocat', remedy: null, command: null });
    mock.getProviders.mockResolvedValue({ providers: [
      { id: 'local-llm', name: 'Local LLM', type: 'api' },
      { id: 'cloud-api', name: 'Cloud API', type: 'api' },
      { id: 'cli-agent', name: 'CLI agent', type: 'cli' },
    ] });
  });

  it('lets a Private account allow a cloud provider for AI sorting, local only by default', async () => {
    mock.updateGitHubAccount.mockImplementation(async (id, body) => ({ ...IMPLICIT, ...body, id }));
    renderAccounts();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.queryByText(/AI providers allowed/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Trust'), { target: { value: 'private' } });
    expect(await screen.findByLabelText('Cloud API')).toBeTruthy();
    expect(screen.queryByLabelText('CLI agent')).toBeNull();
    fireEvent.click(screen.getByLabelText('Cloud API'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mock.updateGitHubAccount).toHaveBeenCalledWith('github-com', expect.objectContaining({ trust: 'private', allowedProviders: ['cloud-api'] })));
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

    expect(mock.createGitHubAccount).toHaveBeenCalledWith({ host: 'ghe.example.com', login: 'alice', label: '', trust: 'private', allowedProviders: null });
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

const NOTIFICATION = {
  accountId: 'github-com', threadId: '101', repoFullName: 'octocat/hello', repoPrivate: false, yourRepo: true,
  reason: 'review_requested', subjectType: 'PullRequest', title: 'Example change', htmlUrl: 'https://github.com/octocat/hello/pull/7',
  unread: true, state: 'open', updatedAt: '2026-10-01T10:00:00.000Z',
};

describe('GitHub inbox tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getGitHubAccounts.mockResolvedValue([IMPLICIT]);
    mock.syncGitHubNotifications.mockResolvedValue({ results: [] });
    mock.getGitHubNotifications.mockResolvedValue({ notifications: [NOTIFICATION], sync: {} });
  });

  it('opens by default, syncs on arrival, and links only to the stored GitHub page', async () => {
    renderTab('');
    expect(await screen.findByText('Example change')).toBeTruthy();
    expect(screen.getByText('Review requested')).toBeTruthy();
    expect(screen.getByText('Your repo')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(NOTIFICATION.htmlUrl);
    expect(mock.syncGitHubNotifications).toHaveBeenCalledWith(null, { silent: true });
    expect(mock.getGitHubRepos).not.toHaveBeenCalled();
  });

  it('marks a thread done and takes it out of Needs you', async () => {
    mock.applyGitHubNotificationAction.mockResolvedValue({ ...NOTIFICATION, state: 'done', unread: false });
    renderTab('inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
    expect(mock.applyGitHubNotificationAction).toHaveBeenCalledWith('github-com', '101', 'done');
    expect(await screen.findByText('Nothing needs you right now.')).toBeTruthy();
  });

  it('undoes Done locally and a mute by re-subscribing', async () => {
    mock.getGitHubNotifications.mockResolvedValue({
      notifications: [{ ...NOTIFICATION, state: 'done' }, { ...NOTIFICATION, threadId: '102', title: 'Muted change', state: 'muted' }],
      sync: {},
    });
    mock.applyGitHubNotificationAction.mockImplementation(async (_account, threadId) => ({ ...NOTIFICATION, threadId, state: 'open' }));
    renderTab('inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Handled' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Back to inbox' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unmute' }));
    await waitFor(() => expect(mock.applyGitHubNotificationAction).toHaveBeenCalledTimes(2));
    expect(mock.applyGitHubNotificationAction).toHaveBeenCalledWith('github-com', '101', 'reopen');
    expect(mock.applyGitHubNotificationAction).toHaveBeenCalledWith('github-com', '102', 'resubscribe');
    await act(async () => {});
  });

  it('shows a failed sync for the account instead of an empty inbox', async () => {
    mock.getGitHubNotifications.mockResolvedValue({
      notifications: [], sync: { 'github-com': { lastSyncAt: null, lastError: 'gh cannot act as github.com (not-authenticated).' } },
    });
    renderTab('inbox');
    expect((await screen.findByRole('alert')).textContent).toContain('not-authenticated');
  });
});

describe('GitHub inbox triage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getGitHubAccounts.mockResolvedValue([IMPLICIT]);
    mock.syncGitHubNotifications.mockResolvedValue({ results: [] });
  });

  it('shows the recorded decision and trust, filters Suspect, and reloads when the server says the inbox changed', async () => {
    mock.getGitHubNotifications.mockResolvedValue({
      notifications: [{ ...NOTIFICATION, decision: 'suggest-untrusted-review', trust: 'outside', suspect: false, signals: [] }],
      sync: {},
    });
    renderTab('inbox');
    expect(await screen.findByText('Suggest Untrusted:Review')).toBeTruthy();
    expect(screen.getByText('Outside')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Suspect' }));
    await waitFor(() => expect(mock.getGitHubNotifications).toHaveBeenLastCalledWith({ accountId: null, view: 'suspect' }, { silent: true }));

    const calls = mock.getGitHubNotifications.mock.calls.length;
    await act(async () => socket.emit('github:notifications:changed', { accountId: 'github-com' }));
    await waitFor(() => expect(mock.getGitHubNotifications.mock.calls.length).toBeGreaterThan(calls));
  });

  it('opens a thread drawer with the rule, spam signals and history', async () => {
    mock.getGitHubNotifications.mockResolvedValue({ notifications: [], sync: {} });
    mock.getGitHubNotification.mockResolvedValue({
      ...NOTIFICATION, decision: 'suspect', trust: 'outside', suspect: true, signals: ['new-account'],
      evidence: { rule: 'spam-signal', actor: 'newcomer', signals: ['new-account'] },
      events: [{ actor: 'automation', kind: 'triaged', detail: { decision: 'suspect', mode: 'observe' }, at: '2026-10-01T10:05:00.000Z' }],
    });
    renderTab('inbox/github-com/101');
    expect(await screen.findByText('Actor account is less than 30 days old')).toBeTruthy();
    expect(screen.getByText(/nothing will act on it automatically/)).toBeTruthy();
    expect(screen.getByText('Triaged: Suspect (observe)')).toBeTruthy();
    expect(mock.getGitHubNotification).toHaveBeenCalledWith('github-com', '101', { silent: true });
  });
});

describe('GitHub automations tab', () => {
  const OVERVIEW = {
    cadence: 'off', cronExpression: null, lastSummary: null,
    accounts: [{ id: 'github-com', label: 'github.com', host: 'github.com', trust: 'public', mode: 'observe', enabled: true, lastSyncAt: null, lastError: null, needsYou: 2, suspect: 1, pending: 0 }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mock.getGitHubAutomations.mockResolvedValue(OVERVIEW);
    mock.syncGitHubNotifications.mockResolvedValue({ results: [] });
    mock.getGitHubAutomationActivity.mockResolvedValue({ actions: [] });
    mock.getGitHubLearnedRules.mockResolvedValue({ rules: [] });
  });

  it('switches an account to Assist, undoes an action and forgets a learned rule', async () => {
    mock.updateGitHubAccount.mockResolvedValue({ id: 'github-com', mode: 'assist' });
    mock.getGitHubAutomationActivity.mockResolvedValue({ actions: [
      { id: '41', accountId: 'github-com', accountLabel: 'github.com', threadId: '9', action: 'done', title: 'CI failed on feature', repoFullName: 'octocat/hello', at: '2026-10-22T00:00:00Z', undoable: true },
      { id: '42', accountId: 'github-com', accountLabel: 'github.com', threadId: '10', action: 'read', title: 'Merged PR', repoFullName: 'octocat/hello', at: '2026-10-22T00:00:00Z', undoable: false },
    ] });
    mock.getGitHubLearnedRules.mockResolvedValue({ rules: [
      { id: '7', accountId: 'github-com', repoFullName: 'octocat/hello', reason: 'mention', actor: 'alice', decision: 'suggest-done', hits: 2 },
    ] });
    mock.undoGitHubAutomationAction.mockResolvedValue({ threadId: '9', state: 'open' });
    mock.deleteGitHubLearnedRule.mockResolvedValue({ ok: true });
    renderTab('automations');

    fireEvent.change(await screen.findByLabelText('Mode'), { target: { value: 'assist' } });
    await waitFor(() => expect(mock.updateGitHubAccount).toHaveBeenCalledWith('github-com', { mode: 'assist' }));
    expect(await screen.findByText(/Never acts on outside or suspect threads/)).toBeTruthy();

    expect(screen.getAllByRole('button', { name: /Undo/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
    await waitFor(() => expect(mock.undoGitHubAutomationAction).toHaveBeenCalledWith('41'));

    fireEvent.click(screen.getByRole('button', { name: 'Forget rule for octocat/hello' }));
    await waitFor(() => expect(screen.queryByText('octocat/hello', { selector: 'span' })).toBeNull());
    expect(mock.deleteGitHubLearnedRule).toHaveBeenCalledWith('7');
  });

  it('turns on the weekday check in one tap and runs one account now', async () => {
    mock.setGitHubNotificationCadence.mockResolvedValue({ ...OVERVIEW, cadence: 'weekdays-15m' });
    renderTab('automations');
    expect(await screen.findByText('Only when you tap Run now')).toBeTruthy();
    expect(screen.getByText(/2 open · 1 suspect/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Check every 15 min on weekdays' }));
    expect(await screen.findByText('Every 15 minutes on weekdays')).toBeTruthy();
    expect(mock.setGitHubNotificationCadence).toHaveBeenCalledWith('weekdays-15m');

    fireEvent.click(screen.getByRole('button', { name: /Run now/ }));
    await waitFor(() => expect(mock.syncGitHubNotifications).toHaveBeenCalledWith('github-com', { silent: true }));
    await waitFor(() => expect(mock.getGitHubAutomations).toHaveBeenCalledTimes(2));
  });
});

describe('GitHub audit tab', () => {
  const ACCOUNT = { id: 'github-com', label: 'github.com', host: 'github.com', trust: 'public', mode: 'observe', enabled: true };
  const AUDIT = {
    accountId: 'github-com', accountLabel: 'github.com', ranAt: '2026-10-22T00:00:00Z', windowDays: 30, watchedListed: true,
    summary: { total: 20, acted: 0, handled: 12, repos: 2 },
    suggestions: [
      { id: 'unwatch:acme/noisy', kind: 'unwatch', repo: 'acme/noisy', stats: { total: 8, acted: 0, handled: 0 }, apply: true, applied: false },
      { id: 'actions-failed-only', kind: 'actions-failed-only', repo: null, stats: { total: 12, acted: 0, handled: 12 }, link: 'https://github.com/settings/notifications', applied: false },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mock.getGitHubAccounts.mockResolvedValue([ACCOUNT]);
    mock.getGitHubAudit.mockResolvedValue({ audit: null });
    mock.getGitHubAuditChanges.mockResolvedValue({ changes: [] });
  });

  it('runs an audit on tap, applies one change, links the rest, and undoes from the log', async () => {
    mock.runGitHubAudit.mockResolvedValue({ audit: AUDIT });
    mock.applyGitHubAuditSuggestion.mockResolvedValue({ id: '5', kind: 'unwatch', repo: 'acme/noisy' });
    renderTab('audit');
    expect(await screen.findByText('Nothing changes until you tap Apply on a suggestion.')).toBeTruthy();
    expect(mock.runGitHubAudit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Run audit/ }));
    expect(await screen.findByText('Unwatch acme/noisy')).toBeTruthy();
    expect(screen.getByText(/20 notifications in 2 repos/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open on GitHub/ }).getAttribute('href')).toBe('https://github.com/settings/notifications');

    mock.getGitHubAuditChanges.mockResolvedValue({ changes: [
      { id: '5', accountId: 'github-com', accountLabel: 'github.com', kind: 'unwatch', repo: 'acme/noisy', threadCount: null, appliedAt: '2026-10-22T00:00:00Z', undone: false },
    ] });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Applied')).toBeTruthy();
    expect(mock.applyGitHubAuditSuggestion).toHaveBeenCalledWith('github-com', 'unwatch:acme/noisy');

    mock.undoGitHubAuditChange.mockResolvedValue({ id: '5', undone: true });
    fireEvent.click(await screen.findByRole('button', { name: /Undo/ }));
    expect(await screen.findByText('Undone')).toBeTruthy();
    expect(mock.undoGitHubAuditChange).toHaveBeenCalledWith('5');
  });
});
