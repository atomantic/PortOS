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
  resolveGitHubNotificationWithAgent: vi.fn(),
  clearFinishedGitHubNotifications: vi.fn(),
  getGitHubDeploymentReview: vi.fn(),
  reviewGitHubDeployment: vi.fn(),
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
vi.mock('../services/apiLocalLlm', () => ({
  getToolUseModels: vi.fn().mockResolvedValue({ models: [] }),
  getVisionModels: vi.fn().mockResolvedValue({ models: [] }),
}));

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
    expect(screen.getByRole('heading', { level: 1, name: 'GitHub' })).toBeInTheDocument();
    expect(screen.getByLabelText('GitHub views')).toBeInTheDocument();
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

  it('lets a Private Enterprise account opt in to agents', async () => {
    mock.updateGitHubAccount.mockImplementation(async (id, body) => ({ ...IMPLICIT, ...body, id }));
    renderAccounts();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.queryByLabelText(/Allow agents/)).toBeNull();
    // github.com is never trusted wholesale.
    expect(screen.queryByLabelText('Trust everyone on this instance')).toBeNull();
    fireEvent.change(screen.getByLabelText('Trust'), { target: { value: 'private' } });
    fireEvent.click(await screen.findByLabelText(/Allow agents/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mock.updateGitHubAccount).toHaveBeenCalledWith('github-com', expect.objectContaining({ trust: 'private', allowAgents: true })));
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
    // An Enterprise host can trust its whole instance, independent of where text goes.
    fireEvent.change(screen.getByLabelText('Trust'), { target: { value: 'public' } });
    fireEvent.click(screen.getByLabelText('Trust everyone on this instance'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Add account' }).at(-1));

    expect(mock.createGitHubAccount).toHaveBeenCalledWith({ host: 'ghe.example.com', login: 'alice', label: '', trust: 'public', allowedProviders: null, allowAgents: false, trustInstanceUsers: true });
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

  it('links a deployment approval to the run waiting on you', async () => {
    const runUrl = 'https://github.com/octocat/hello/actions/runs/4242';
    mock.getGitHubNotifications.mockResolvedValue({
      notifications: [{
        ...NOTIFICATION, reason: 'approval_requested', subjectType: 'WorkflowRun', title: 'Someone requested your review to deploy to an environment',
        decision: 'surface-high', htmlUrl: runUrl, deployment: { runId: 4242, name: 'Deploy (prod)', headBranch: 'main', displayTitle: 'Example change', htmlUrl: runUrl },
      }],
      sync: {},
    });
    renderTab('inbox');
    expect(await screen.findByText('Deploy approval')).toBeTruthy();
    expect(screen.getByText('Deploy (prod)')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(runUrl);
  });

  it('approves a waiting deployment from its row, only for environments you can approve', async () => {
    const deployment = { runId: 4242, name: 'Deploy (prod)', headBranch: 'main', displayTitle: 'Example change', htmlUrl: 'https://github.com/octocat/hello/actions/runs/4242' };
    mock.getGitHubNotifications.mockResolvedValue({
      notifications: [{ ...NOTIFICATION, reason: 'approval_requested', subjectType: 'WorkflowRun', decision: 'surface-high', htmlUrl: deployment.htmlUrl, deployment }],
      sync: {},
    });
    mock.getGitHubDeploymentReview.mockResolvedValue({
      runId: 4242,
      environments: [
        { environmentId: 11, name: 'prod', canApprove: true, waitTimer: 0, reviewers: ['octocat'] },
        { environmentId: 12, name: 'prod-eu', canApprove: false, waitTimer: 0, reviewers: ['release-team'] },
      ],
    });
    mock.reviewGitHubDeployment.mockResolvedValue({ ...NOTIFICATION, state: 'done' });
    renderTab('inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Review deployment' }));
    expect((await screen.findByLabelText(/^prod$/)).checked).toBe(true);
    expect(screen.getByLabelText(/prod-eu/).disabled).toBe(true);
    expect(screen.getByText(/only release-team can approve/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and deploy' }));
    await waitFor(() => expect(mock.reviewGitHubDeployment).toHaveBeenCalledWith('github-com', '101', { state: 'approved', environmentIds: [11] }));
    expect(await screen.findByText('Your inbox is clear.')).toBeTruthy();
  });

  it('marks a thread done and takes it out of the inbox', async () => {
    mock.applyGitHubNotificationAction.mockResolvedValue({ ...NOTIFICATION, state: 'done', unread: false });
    renderTab('inbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
    expect(mock.applyGitHubNotificationAction).toHaveBeenCalledWith('github-com', '101', 'done');
    expect(await screen.findByText('Your inbox is clear.')).toBeTruthy();
  });

  it('marks every finished thread done in one tap', async () => {
    mock.getGitHubNotifications.mockResolvedValue({
      notifications: [NOTIFICATION, { ...NOTIFICATION, threadId: '102', title: 'Folded CI notice', decision: 'duplicate' }],
      counts: { 'needs-you': 2, suspect: 0, handled: 0, all: 2, finished: 1 },
      sync: {},
    });
    mock.clearFinishedGitHubNotifications.mockResolvedValue({ cleared: 1, failed: 0 });
    renderTab('inbox');
    // The inbox mirrors GitHub's, so a folded duplicate is listed with its pill.
    expect(await screen.findByText('Folded CI notice')).toBeTruthy();
    expect(screen.getByText('Duplicate')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark 1 finished done' }));
    await waitFor(() => expect(mock.clearFinishedGitHubNotifications).toHaveBeenCalledWith(null));
  });

  it('offers Resolve with agent on every open row, runs it on the picked agent, and says why when it cannot', async () => {
    mock.getProviders.mockResolvedValue({ providers: [{ id: 'example-provider', name: 'Example Provider', type: 'cli', enabled: true, models: ['example-model'], defaultModel: 'example-model' }] });
    mock.getGitHubNotifications.mockResolvedValue({
      notifications: [
        { ...NOTIFICATION, agent: { lane: 'notification-resolve', refused: null, pin: { provider: 'example-provider', model: 'example-model' } } },
        { ...NOTIFICATION, threadId: '102', title: 'Alert elsewhere', reason: 'security_alert', agent: { lane: 'dependency-updates', refused: 'no-managed-app', pin: null } },
        { ...NOTIFICATION, threadId: '103', title: 'Outside thread', agent: { lane: 'notification-resolve', refused: 'outside-content', pin: null } },
      ],
      sync: {},
    });
    mock.resolveGitHubNotificationWithAgent.mockResolvedValue({ ...NOTIFICATION, decision: 'handed-off', agent: { lane: 'notification-resolve', refused: 'handed-off', pin: null } });
    renderTab('inbox');
    expect(await screen.findByText('Add this repo as a PortOS app to resolve it with an agent')).toBeTruthy();
    expect(screen.getByText(/Outside content goes only to the screened/)).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'Resolve with agent' });
    expect(buttons.map((button) => button.disabled)).toEqual([false, true, true]);
    fireEvent.click(buttons[0]);
    // The picker starts from the rule pin or account defaults the server sent.
    const start = await screen.findByRole('button', { name: 'Start agent' });
    await waitFor(() => expect(start.disabled).toBe(false));
    await waitFor(() => expect(screen.getByLabelText(/^Provider/).value).toBe('example-provider'));
    fireEvent.click(start);
    await waitFor(() => expect(mock.resolveGitHubNotificationWithAgent).toHaveBeenCalledWith('github-com', '101', { provider: 'example-provider', model: 'example-model', effort: null }));
    // A handed-off thread stays in the inbox, as it does on GitHub, with its pill.
    expect(await screen.findByText('Handed off')).toBeTruthy();
    expect(screen.getByText('Example change')).toBeTruthy();
    expect(screen.getByText('An agent already has this thread')).toBeTruthy();
  });

  it('links an Agent failed pill to the run that failed', async () => {
    mock.getGitHubNotifications.mockResolvedValue({
      notifications: [{ ...NOTIFICATION, agent: { lane: 'notification-resolve', refused: null, pin: null }, agentFailed: { taskId: 'task-1', agentId: 'agent-7' } }],
      sync: {},
    });
    renderTab('inbox');
    expect((await screen.findByText('Agent failed')).closest('a').getAttribute('href')).toBe('/cos/agents/agent-7');
    expect(screen.getByRole('button', { name: 'Resolve with agent' }).disabled).toBe(false);
  });

  it('undoes Done locally and a mute by re-subscribing', async () => {
    mock.getGitHubNotifications.mockResolvedValue({
      notifications: [{ ...NOTIFICATION, state: 'done' }, { ...NOTIFICATION, threadId: '102', title: 'Muted change', state: 'muted' }],
      sync: {},
    });
    mock.applyGitHubNotificationAction.mockImplementation(async (_account, threadId) => ({ ...NOTIFICATION, threadId, state: 'open' }));
    renderTab('inbox');
    fireEvent.click(await screen.findByRole('button', { name: /^Handled/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Back to inbox' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unmute' }));
    await waitFor(() => expect(mock.applyGitHubNotificationAction).toHaveBeenCalledTimes(2));
    expect(mock.applyGitHubNotificationAction).toHaveBeenCalledWith('github-com', '101', 'reopen');
    expect(mock.applyGitHubNotificationAction).toHaveBeenCalledWith('github-com', '102', 'resubscribe');
    await act(async () => {});
  });

  it('shows each view count in its tile and narrows the list to one repository', async () => {
    mock.getGitHubNotifications.mockResolvedValue({
      notifications: [NOTIFICATION, { ...NOTIFICATION, threadId: '102', title: 'Other repo change', repoFullName: 'octocat/other' }],
      counts: { 'needs-you': 2, suspect: 0, handled: 14, all: 16, 'with-agents': 3 },
      sync: {},
    });
    renderTab('inbox');
    expect(await screen.findByRole('button', { name: 'Handled 14' })).toBeTruthy();
    expect(screen.getByText('3 with an agent now')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'octocat/other' } });
    expect(screen.queryByText('Example change')).toBeNull();
    expect(screen.getByText('Other repo change')).toBeTruthy();
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

    fireEvent.click(screen.getByRole('button', { name: /^Suspect/ }));
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

  it('shows which lane Autopilot handed a thread to, linked to its app', async () => {
    mock.getGitHubNotifications.mockResolvedValue({ notifications: [], sync: {} });
    mock.getGitHubNotification.mockResolvedValue({
      ...NOTIFICATION, decision: 'handed-off', trust: 'outside', suspect: false, signals: [],
      evidence: { rule: 'review-outside-author', actor: 'mallory', handoff: { lane: 'pr-reviewer', appId: 'app-acme', appName: 'Acme App', pullNumber: 101, requestId: 'demand-1' } },
      events: [{ actor: 'automation', kind: 'handed-off', detail: { lane: 'pr-reviewer', appId: 'app-acme' }, at: '2026-10-01T10:05:00.000Z' }],
    });
    renderTab('inbox/github-com/101');
    expect((await screen.findByRole('link', { name: 'Acme App' })).getAttribute('href')).toBe('/apps/app-acme/pull-requests');
    expect(screen.getByText('Handed off to Untrusted:Review by Autopilot')).toBeTruthy();
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

  it('shows agent rules on a Private account and allows agents, or stops, from its card', async () => {
    const enterprise = { ...OVERVIEW.accounts[0], id: 'ghe', label: 'ghe.example.com', host: 'ghe.example.com', trust: 'private', mode: 'autopilot', agentRules: [], repos: [] };
    mock.getGitHubAutomations.mockResolvedValue({ ...OVERVIEW, accounts: [{ ...enterprise, allowAgents: false }] });
    mock.updateGitHubAccount.mockImplementation(async (id, data) => ({ ...enterprise, id, ...data }));
    renderTab('automations');
    expect(await screen.findByRole('button', { name: /Add rule/ })).toBeTruthy();
    expect(screen.getByText(/start no agent until you allow agents/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow agents on this account' }));
    await waitFor(() => expect(mock.updateGitHubAccount).toHaveBeenCalledWith('ghe', { allowAgents: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop allowing agents' }));
    await waitFor(() => expect(mock.updateGitHubAccount).toHaveBeenCalledWith('ghe', { allowAgents: false }));
    expect(await screen.findByRole('button', { name: 'Allow agents on this account' })).toBeTruthy();
  });

  it('sets an account\'s agent defaults for Resolve with agent, and clears them back to CoS defaults', async () => {
    mock.getProviders.mockResolvedValue({ providers: [{ id: 'example-provider', name: 'Example Provider', type: 'cli', enabled: true, models: ['example-model'], defaultModel: 'example-model' }] });
    mock.getGitHubAutomations.mockResolvedValue({ ...OVERVIEW, accounts: [{ ...OVERVIEW.accounts[0], agentDefaults: { provider: 'example-provider', effort: 'high' }, agentRules: [], repos: [] }] });
    mock.updateGitHubAccount.mockImplementation(async (id, data) => ({ ...OVERVIEW.accounts[0], id, ...data }));
    renderTab('automations');
    expect(await screen.findByText(/^Example Provider · high effort/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    const save = await screen.findByRole('button', { name: 'Save defaults' });
    await waitFor(() => expect(save.disabled).toBe(false));
    await waitFor(() => expect(screen.getByLabelText(/^Provider/).value).toBe('example-provider'));
    fireEvent.change(screen.getByLabelText(/^Provider/), { target: { value: '' } });
    fireEvent.click(save);
    await waitFor(() => expect(mock.updateGitHubAccount).toHaveBeenCalledWith('github-com', { agentDefaults: null }));
    expect(await screen.findByText(/^CoS defaults/)).toBeTruthy();
  });

  it('adds an agent rule for review requests in one repo and refuses a duplicate', async () => {
    mock.getProviders.mockResolvedValue({ providers: [{ id: 'example-provider', name: 'Example Provider', type: 'cli', enabled: true, models: ['example-model'], defaultModel: 'example-model' }] });
    mock.getGitHubAutomations.mockResolvedValue({
      ...OVERVIEW,
      accounts: [{ ...OVERVIEW.accounts[0], mode: 'autopilot', agentRules: [{ id: 'rule-1', kind: 'review-request', repo: '*', agent: false }], repos: ['octocat/hello'] }],
    });
    mock.updateGitHubAccount.mockImplementation(async (id, data) => ({ id, ...data }));
    renderTab('automations');

    expect(await screen.findByText("Don't start an agent")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add rule/ }));
    // Same kind and repo as the existing rule: refused until changed.
    expect(await screen.findByText(/There is already a rule/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('In'), { target: { value: 'octocat/hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(mock.updateGitHubAccount).toHaveBeenCalledWith('github-com', {
      agentRules: [
        { id: 'rule-1', kind: 'review-request', repo: '*', agent: false },
        expect.objectContaining({ kind: 'review-request', repo: 'octocat/hello', agent: true }),
      ],
    }));
    expect(await screen.findByText('octocat/hello', { selector: 'span' })).toBeTruthy();
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

  it('turns on the monthly audit report for the selected account', async () => {
    mock.updateGitHubAccount.mockResolvedValue({ ...ACCOUNT, auditReport: true });
    renderTab('audit');
    const toggle = await screen.findByLabelText(/Send me this audit monthly/);
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByLabelText(/Send me this audit monthly/).checked).toBe(true));
    expect(mock.updateGitHubAccount).toHaveBeenCalledWith('github-com', { auditReport: true });
  });
});
