import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const { socketHandlers, socketMock } = vi.hoisted(() => {
  const handlers = new Map();
  const mock = {
    connected: true,
    on: vi.fn((event, handler) => handlers.set(event, handler)),
    off: vi.fn((event, handler) => {
      if (handlers.get(event) === handler) handlers.delete(event);
    }),
    emit: vi.fn(),
  };
  return { socketHandlers: handlers, socketMock: mock };
});

const { toastMock } = vi.hoisted(() => {
  const fn = vi.fn();
  fn.success = vi.fn();
  fn.error = vi.fn();
  return { toastMock: fn };
});

vi.mock('../../../services/socket', () => ({ default: socketMock }));
vi.mock('../../../services/apiLocalLlm', () => ({
  getToolUseModels: vi.fn().mockResolvedValue({ models: [] }),
  getVisionModels: vi.fn().mockResolvedValue({ models: [] }),
}));
vi.mock('../../ui/Toast', () => ({ default: toastMock }));
vi.mock('../../../services/api', () => ({
  getAppPullRequests: vi.fn(),
  getInstanceFeatures: vi.fn().mockResolvedValue({ features: {} }),
  resolveAppPullRequest: vi.fn(),
  reviewAppPullRequest: vi.fn(),
  doReviewAppPullRequest: vi.fn(),
  mergeAppPullRequest: vi.fn(),
  getProviders: vi.fn(),
  // The run-settings panel's reviewer override reads the install's Code Review
  // Defaults for its seed and the reviewer Model column's options.
  getCodeReviewDefaults: vi.fn(),
  getLocalLlmStatus: vi.fn(),
}));

import * as api from '../../../services/api';
import PullRequestsTab from './PullRequestsTab';

const PULL_REQUEST = {
  number: 17,
  title: 'Fix the save path',
  url: 'https://github.com/acme/widget/pull/17',
  state: 'open',
  author: 'alice',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-02T00:00:00Z',
  isDraft: false,
  headBranch: 'fix/save-path',
  baseBranch: 'main',
  reviewDecision: 'CHANGES_REQUESTED',
  mergeStateStatus: 'DIRTY',
  mergeable: 'CONFLICTING',
  labels: ['bug'],
  reviewEligible: true,
  doReviewEligible: true,
  mergeEligible: true,
  checks: [
    { name: 'unit', status: 'SUCCESS', url: null },
    { name: 'lint', status: 'SUCCESS', url: null },
  ],
};

const okPayload = (pullRequests) => ({
  forge: 'github',
  fullName: 'acme/widget',
  pullRequests,
  reason: pullRequests.length ? 'ok' : 'no-open-pull-requests',
  transient: false,
  headline: null,
  remedy: null,
});

const renderTab = async () => {
  const result = render(
    <MemoryRouter>
      <PullRequestsTab appId="app-1" appName="Widget" />
    </MemoryRouter>,
  );
  await act(async () => {});
  return result;
};

beforeEach(() => {
  socketHandlers.clear();
  socketMock.on.mockClear();
  socketMock.off.mockClear();
  socketMock.emit.mockClear();
  api.getAppPullRequests.mockResolvedValue(okPayload([PULL_REQUEST]));
  api.resolveAppPullRequest.mockResolvedValue({
    task: { id: 'task-1', status: 'pending' },
    duplicate: false,
    started: true,
    queueReason: null,
  });
  api.reviewAppPullRequest.mockResolvedValue({
    requestId: 'demand-abc',
    reviewAction: { taskId: null, status: 'pending' },
    duplicate: false,
  });
  api.doReviewAppPullRequest.mockResolvedValue({
    number: 17,
    doReviewAction: { taskId: 'task-doreview-1', status: 'pending' },
    duplicate: false,
    started: true,
    queueReason: null,
  });
  api.mergeAppPullRequest.mockResolvedValue({ number: 17, merged: true, method: 'merge', deletedBranch: true });
  api.getProviders.mockResolvedValue({ activeProvider: '', providers: [] });
  api.getCodeReviewDefaults.mockResolvedValue({
    reviewers: ['codex'], usernames: [], optionalReviewers: [], reviewerMaxRounds: {},
    stopMode: 'all', reviewerApplies: false, installed: {},
  });
  api.getLocalLlmStatus.mockResolvedValue({ backends: {} });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PullRequestsTab', () => {
  it('loads open requests and renders review, check, merge, author, and branch state', async () => {
    await renderTab();

    expect(await screen.findByText('Fix the save path')).toBeInTheDocument();
    expect(api.getAppPullRequests).toHaveBeenCalledWith('app-1');
    expect(screen.getByText('#17')).toBeInTheDocument();
    expect(screen.getByText('Changes requested')).toBeInTheDocument();
    expect(screen.getByText('Checks passing')).toBeInTheDocument();
    expect(screen.getByText('Conflicts')).toBeInTheDocument();
    expect(screen.getByText(/alice/)).toBeInTheDocument();
    expect(screen.getByText(/fix\/save-path/)).toBeInTheDocument();
    expect(screen.getByText('acme/widget')).toBeInTheDocument();
  });

  it('sends the page-level provider/model/effort pin along with a resolve action', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'claude', name: 'Claude', type: 'cli', enabled: true,
        models: ['claude-opus-5', 'claude-sonnet-5'], defaultModel: 'claude-sonnet-5',
      }],
    });
    await renderTab();

    await screen.findByText('Fix the save path');
    fireEvent.change(await screen.findByLabelText('Provider'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-opus-5' } });

    fireEvent.click(screen.getByRole('button', { name: /Resolve & merge/ }));

    await waitFor(() => expect(api.resolveAppPullRequest).toHaveBeenCalledWith(
      'app-1', 17, { provider: 'claude', model: 'claude-opus-5', effort: undefined, reviewMode: 'delegated' },
    ));
  });

  it('preserves scheduled review stages unless the user explicitly enables the override', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'claude', name: 'Claude', type: 'cli', enabled: true,
        models: ['claude-opus-5', 'claude-sonnet-5'], defaultModel: 'claude-sonnet-5',
      }],
    });
    await renderTab();

    await screen.findByText('Fix the save path');
    fireEvent.change(await screen.findByLabelText('Provider'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-opus-5' } });

    fireEvent.click(screen.getByRole('button', { name: /PR review/ }));

    await waitFor(() => expect(api.reviewAppPullRequest).toHaveBeenCalledWith(
      'app-1', 17, {},
    ));
  });

  // PR review hands its run to the `pr-reviewer` scheduled task, so it takes the
  // provider pin only when the user opts in — and never the Code review setting,
  // which governs the two actions PortOS composes here.
  it('passes the Run with pin to PR review once the opt-in is ticked, and nothing else', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'claude', name: 'Claude', type: 'cli', enabled: true,
        models: ['claude-opus-5', 'claude-sonnet-5'], defaultModel: 'claude-sonnet-5',
      }],
    });
    await renderTab();

    await screen.findByText('Fix the save path');
    fireEvent.change(await screen.findByLabelText('Provider'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-opus-5' } });
    fireEvent.change(screen.getByLabelText('Code review'), { target: { value: 'self' } });

    fireEvent.click(screen.getByLabelText('Also run PR review on the Run with provider'));
    fireEvent.click(screen.getByRole('button', { name: /PR review/ }));

    await waitFor(() => expect(api.reviewAppPullRequest).toHaveBeenCalledWith(
      'app-1', 17, { provider: 'claude', model: 'claude-opus-5', effort: undefined },
    ));
  });
  it('queues a review-loop resolve action and shows its task state', async () => {
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Resolve & merge/ }));

    await waitFor(() => expect(api.resolveAppPullRequest).toHaveBeenCalledWith(
      'app-1', 17, { provider: undefined, model: undefined, effort: undefined, reviewMode: 'delegated' },
    ));
    expect(await screen.findByRole('link', { name: /Queued/ })).toBeInTheDocument();
  });

  // The server starts the follow-up on the click, so the toast must say so —
  // and must NOT claim an agent is on it when the dispatch was refused.
  it('reports that the resolve agent started', async () => {
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Resolve & merge/ }));

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringContaining('Started an agent to resolve and merge'),
    ));
  });

  it('surfaces why a resolve task is queued but not yet running', async () => {
    api.resolveAppPullRequest.mockResolvedValue({
      task: { id: 'task-1', status: 'pending' },
      duplicate: false,
      started: false,
      queueReason: 'No available agent slots (3/3)',
    });
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Resolve & merge/ }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(
      expect.stringContaining('No available agent slots (3/3)'),
    ));
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(await screen.findByRole('link', { name: /Queued/ })).toBeInTheDocument();
  });

  it('tracks queued, active, and completed action states from the CoS socket', async () => {
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Resolve & merge/ }));
    expect(await screen.findByRole('link', { name: /Queued/ })).toBeInTheDocument();

    act(() => socketHandlers.get('cos:tasks:changed')({
      task: { id: 'task-1', status: 'in_progress' },
    }));
    expect(await screen.findByRole('link', { name: /Active/ })).toBeInTheDocument();

    act(() => socketHandlers.get('cos:tasks:changed')({
      task: { id: 'task-1', status: 'completed' },
    }));
    expect(await screen.findByRole('link', { name: /Completed/ })).toBeInTheDocument();
  });

  it('does not treat a failed agent completion as a completed action', async () => {
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Resolve & merge/ }));
    expect(await screen.findByRole('link', { name: /Queued/ })).toBeInTheDocument();

    act(() => socketHandlers.get('cos:agent:completed')({
      taskId: 'task-1', result: { success: false },
    }));

    expect(screen.getByRole('link', { name: /Queued/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Completed/ })).not.toBeInTheDocument();
  });

  it('applies every task from a user task-list update', async () => {
    const SECOND_PULL_REQUEST = {
      ...PULL_REQUEST,
      number: 18,
      title: 'Repair the sync path',
      url: 'https://github.com/acme/widget/pull/18',
    };
    api.getAppPullRequests.mockResolvedValue(okPayload([PULL_REQUEST, SECOND_PULL_REQUEST]));
    api.resolveAppPullRequest
      .mockResolvedValueOnce({ task: { id: 'task-1', status: 'pending' }, duplicate: false })
      .mockResolvedValueOnce({ task: { id: 'task-2', status: 'pending' }, duplicate: false });
    await renderTab();

    const resolveButtons = await screen.findAllByRole('button', { name: /Resolve & merge/ });
    fireEvent.click(resolveButtons[0]);
    fireEvent.click(resolveButtons[1]);
    await waitFor(() => expect(api.resolveAppPullRequest).toHaveBeenCalledTimes(2));

    act(() => socketHandlers.get('cos:tasks:user:changed')({
      tasks: [
        { id: 'task-1', status: 'completed' },
        { id: 'task-2', status: 'completed' },
      ],
    }));

    await waitFor(() => expect(screen.getAllByRole('link', { name: /Completed/ })).toHaveLength(2));
  });

  it('removes every CoS socket listener when unmounted', async () => {
    const listenerCountBeforeMount = socketHandlers.size;
    const { unmount } = await renderTab();

    expect(socketHandlers.size).toBe(listenerCountBeforeMount + 6);
    unmount();
    expect(socketHandlers.size).toBe(listenerCountBeforeMount);
  });

  it('hydrates an active server-side resolve action without offering another button', async () => {
    api.getAppPullRequests.mockResolvedValue(okPayload([{
      ...PULL_REQUEST,
      agentAction: { taskId: 'task-active', status: 'in_progress' },
    }]));

    await renderTab();

    expect(await screen.findByRole('link', { name: /Active/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Resolve & merge/ })).not.toBeInTheDocument();
  });

  it('queues a pr-reviewer run scoped to the row it was pressed on', async () => {
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /PR review/ }));

    await waitFor(() => expect(api.reviewAppPullRequest).toHaveBeenCalledWith(
      'app-1', 17, {},
    ));
    expect(await screen.findByRole('link', { name: /PR review: Queued/ })).toBeInTheDocument();
    // The resolve action is a separate lane and must stay offered.
    expect(screen.getByRole('button', { name: /Resolve & merge/ })).toBeInTheDocument();
  });

  it('binds a pr-reviewer task update to the row by its target PR number', async () => {
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /PR review/ }));
    expect(await screen.findByRole('link', { name: /PR review: Queued/ })).toBeInTheDocument();

    act(() => socketHandlers.get('cos:tasks:changed')({
      task: {
        id: 'app-improve-17',
        status: 'in_progress',
        metadata: { app: 'app-1', analysisType: 'pr-reviewer', targetPullRequest: 17 },
      },
    }));

    expect(await screen.findByRole('link', { name: /PR review: Active/ })).toBeInTheDocument();
  });

  it('restores the preflight explanation after reloading the PR list', async () => {
    api.getAppPullRequests.mockResolvedValue(okPayload([{ ...PULL_REQUEST,
      reviewAction: { taskId: 'preflight-17', status: 'failed', error: 'Prompt Guard stopped before an agent started.' },
    }]));
    await renderTab();
    expect(await screen.findByRole('alert')).toHaveTextContent('Prompt Guard stopped');
    expect(screen.getByRole('button', { name: 'Retry PR review' })).toBeInTheDocument();
  });

  it('replaces a queued review with a durable preflight explanation and retry', async () => {
    await renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /PR review/ }));
    await screen.findByRole('link', { name: /PR review: Queued/ });
    act(() => socketHandlers.get('cos:tasks:changed')({ task: {
      id: 'preflight-17', status: 'completed',
      metadata: { app: 'app-1', analysisType: 'pr-reviewer', targetPullRequest: 17,
        preflightFailure: 'security-guard-process-failed', note: 'Prompt Guard stopped before an agent started.' },
    } }));
    expect(screen.getByRole('alert')).toHaveTextContent('before an agent started');
    expect(screen.getByRole('link', { name: 'View failure record' })).toHaveAttribute('href', '/cos/tasks?task=preflight-17&source=internal');
    fireEvent.click(screen.getByRole('button', { name: 'Retry PR review' }));
    await waitFor(() => expect(api.reviewAppPullRequest).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('link', { name: /PR review: Queued/ })).toBeInTheDocument();
  });

  // #7258: the preflight card is the programmatic phase of this row's run, and
  // it COMPLETES the moment the review agent task is created. Reading that as
  // the row's own completion would freeze it at "Completed" and ignore every
  // later update, because a row binds to one task id for good.
  it('follows a finished preflight card onto the review task it started', async () => {
    await renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /PR review/ }));
    await screen.findByRole('link', { name: /PR review: Queued/ });
    act(() => socketHandlers.get('cos:tasks:changed')({ task: {
      id: 'preflight-demand-1', status: 'in_progress',
      metadata: { app: 'app-1', analysisType: 'pr-reviewer', targetPullRequest: 17,
        preflight: { phase: 'preparing', steps: [] } },
    } }));
    expect(await screen.findByRole('link', { name: /PR review: Active/ })).toBeInTheDocument();

    act(() => socketHandlers.get('cos:tasks:changed')({ task: {
      id: 'preflight-demand-1', status: 'completed',
      metadata: { app: 'app-1', analysisType: 'pr-reviewer', targetPullRequest: 17,
        preflightResultTaskId: 'app-improve-17',
        preflight: { phase: 'done', outcome: 'handed-off', steps: [] } },
    } }));
    expect(await screen.findByRole('link', { name: /PR review: Active/ })).toBeInTheDocument();

    act(() => socketHandlers.get('cos:tasks:changed')({ task: {
      id: 'app-improve-17', status: 'completed',
      metadata: { app: 'app-1', analysisType: 'pr-reviewer', targetPullRequest: 17 },
    } }));
    expect(await screen.findByRole('link', { name: /PR review: Completed/ }))
      .toHaveAttribute('href', '/cos/tasks?task=app-improve-17&source=internal');
  });

  it('offers Do:Review on a row pr-reviewer will not touch, and queues it', async () => {
    // The screenshot case: a code contributor's PR, ineligible for the
    // pr-reviewer sweep, previously left with Resolve & merge as its only action.
    api.getAppPullRequests.mockResolvedValue(okPayload([{ ...PULL_REQUEST, reviewEligible: false }]));
    await renderTab();

    expect(await screen.findByText('Fix the save path')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'PR review' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Do:Review' }));

    await waitFor(() => expect(api.doReviewAppPullRequest).toHaveBeenCalledWith(
      'app-1', 17, { provider: undefined, model: undefined, effort: undefined, reviewMode: 'delegated' },
    ));
    expect(await screen.findByRole('link', { name: /Do:Review: Queued/ })).toBeInTheDocument();
    expect(toastMock.success).toHaveBeenCalledWith('Started an agent to run /do:review against GitHub #17');
  });

  it('hides Do:Review on a GitLab forge, where slashdo PR mode cannot run', async () => {
    api.getAppPullRequests.mockResolvedValue({
      ...okPayload([{ ...PULL_REQUEST, reviewEligible: false, doReviewEligible: false }]),
      forge: 'gitlab',
    });
    await renderTab();

    expect(await screen.findByText('Fix the save path')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Do:Review' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolve & merge' })).toBeInTheDocument();
  });

  it('binds a /do:review socket update to the row that queued it', async () => {
    await renderTab();
    await screen.findByText('Fix the save path');
    fireEvent.click(screen.getByRole('button', { name: 'Do:Review' }));
    await screen.findByRole('link', { name: /Do:Review: Queued/ });

    act(() => socketHandlers.get('cos:tasks:changed')({ task: {
      id: 'task-doreview-1', status: 'in_progress',
      metadata: { app: 'app-1', slashdoCommand: 'review', targetPullRequest: 17 },
    } }));

    expect(await screen.findByRole('link', { name: /Do:Review: Active/ }))
      .toHaveAttribute('href', '/cos/tasks?task=task-doreview-1&source=internal');
    // The resolve row is backed by a different task and must not follow along.
    expect(screen.getByRole('button', { name: 'Resolve & merge' })).toBeInTheDocument();
  });

  it('names a failed resolve retry as a merge action and retries that same action', async () => {
    api.getAppPullRequests.mockResolvedValue(okPayload([{
      ...PULL_REQUEST,
      agentAction: { taskId: 'resolve-failed', status: 'failed' },
    }]));
    await renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent('Resolve & merge failed');
    expect(screen.queryByRole('link', { name: 'Abuse Guard setup' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry PR review' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Resolve & merge' }));
    await waitFor(() => expect(api.resolveAppPullRequest).toHaveBeenCalledWith(
      'app-1', 17, { provider: undefined, model: undefined, effort: undefined, reviewMode: 'delegated' },
    ));
    expect(api.reviewAppPullRequest).not.toHaveBeenCalled();
    expect(await screen.findByRole('link', { name: /Resolve & merge: Queued/ })).toBeInTheDocument();
  });

  it('hydrates an in-flight pr-reviewer run without offering the button again', async () => {
    api.getAppPullRequests.mockResolvedValue(okPayload([{
      ...PULL_REQUEST,
      reviewAction: { taskId: 'app-improve-17', status: 'in_progress' },
    }]));

    await renderTab();

    expect(await screen.findByRole('link', { name: /PR review: Active/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /PR review/ })).not.toBeInTheDocument();
  });

  it('omits the pr-reviewer action on a row the server marked ineligible', async () => {
    api.getAppPullRequests.mockResolvedValue(okPayload([{ ...PULL_REQUEST, reviewEligible: false }]));

    await renderTab();

    expect(await screen.findByRole('button', { name: /Resolve & merge/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /PR review/ })).not.toBeInTheDocument();
  });

  it('merges a request directly once the inline confirm is answered', async () => {
    await renderTab();
    // The row must clear on the merge itself, not on the reload behind it — a
    // merged request still offering a Merge button is the misleading state.
    api.getAppPullRequests.mockImplementation(() => new Promise(() => {}));

    fireEvent.click(await screen.findByRole('button', { name: /^Merge$/ }));
    // Arming alone must not merge — the confirm row is the approval.
    expect(api.mergeAppPullRequest).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Merge method for #17'), { target: { value: 'squash' } });
    fireEvent.click(screen.getByRole('button', { name: /Merge #17/ }));

    await waitFor(() => expect(api.mergeAppPullRequest).toHaveBeenCalledWith(
      'app-1', 17, { method: 'squash', deleteBranch: true },
    ));
    expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining('Merged GitHub #17'));
    await waitFor(() => expect(screen.queryByText('Fix the save path')).not.toBeInTheDocument());
  });

  it('honors an unchecked delete-branch box', async () => {
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /^Merge$/ }));
    fireEvent.click(screen.getByLabelText('Delete branch'));
    fireEvent.click(screen.getByRole('button', { name: /Merge #17/ }));

    await waitFor(() => expect(api.mergeAppPullRequest).toHaveBeenCalledWith(
      'app-1', 17, { method: 'merge', deleteBranch: false },
    ));
  });

  it('keeps the confirm row open so a refused merge method can be changed', async () => {
    api.mergeAppPullRequest.mockRejectedValue(new Error('Squash merges are not allowed on this repository'));

    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /^Merge$/ }));
    fireEvent.click(screen.getByRole('button', { name: /Merge #17/ }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('Squash merges are not allowed')));
    expect(screen.getByLabelText('Merge method for #17')).toBeInTheDocument();
    expect(screen.getByText('Fix the save path')).toBeInTheDocument();
  });

  it('omits the merge action on a row the server marked unmergeable', async () => {
    api.getAppPullRequests.mockResolvedValue(okPayload([{ ...PULL_REQUEST, mergeEligible: false }]));

    await renderTab();

    expect(await screen.findByRole('button', { name: /Resolve & merge/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Merge$/ })).not.toBeInTheDocument();
  });

  it('keeps forge failures distinct from a healthy empty list', async () => {
    api.getAppPullRequests.mockResolvedValue({
      forge: 'github',
      fullName: 'acme/widget',
      pullRequests: [],
      reason: 'gh-unauthenticated',
      transient: true,
      headline: "Couldn't reach GitHub",
      remedy: 'run gh auth login',
    });

    await renderTab();

    expect(await screen.findByText(/Couldn't reach GitHub/)).toBeInTheDocument();
    expect(screen.queryByText('No open pull requests or merge requests.')).not.toBeInTheDocument();
  });

  it('shows a healthy empty state when the forge answers with no open requests', async () => {
    api.getAppPullRequests.mockResolvedValue(okPayload([]));

    await renderTab();

    expect(await screen.findByText('No open pull requests or merge requests.')).toBeInTheDocument();
  });

  // Four permanently-expanded paragraphs of reference text used to push the run
  // settings and the first request off a laptop screen.
  it('keeps the action explainer collapsed until asked for', async () => {
    await renderTab();

    const disclosure = await screen.findByRole('button', { name: /What each action does/ });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/Merge lands the request on the forge immediately/)).not.toBeInTheDocument();

    fireEvent.click(disclosure);

    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Merge lands the request on the forge immediately/)).toBeInTheDocument();
  });

  it('sends the self-review mode with the two actions PortOS composes itself', async () => {
    await renderTab();
    await screen.findByText('Fix the save path');

    fireEvent.change(screen.getByLabelText('Code review'), { target: { value: 'self' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resolve & merge' }));
    await waitFor(() => expect(api.resolveAppPullRequest).toHaveBeenCalledWith(
      'app-1', 17, expect.objectContaining({ reviewMode: 'self' }),
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Do:Review' }));
    await waitFor(() => expect(api.doReviewAppPullRequest).toHaveBeenCalledWith(
      'app-1', 17, expect.objectContaining({ reviewMode: 'self' }),
    ));
  });

  // The roster only travels when the user actually edited it — an untouched
  // picker must leave the server resolving the defaults at spawn time rather
  // than freezing whatever this tab happened to render.
  it('omits the reviewer roster while the picker is untouched', async () => {
    await renderTab();
    await screen.findByText('Fix the save path');

    fireEvent.click(screen.getByRole('button', { name: /Reviewer override/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Resolve & merge' }));

    await waitFor(() => expect(api.resolveAppPullRequest).toHaveBeenCalled());
    expect(api.resolveAppPullRequest.mock.calls[0][2]).not.toHaveProperty('reviewers');
  });

  // Dropping the seeded `codex` row is an edit, so the (now empty) roster has to
  // be sent — otherwise the run silently reviews with the very default the user
  // just removed.
  it('sends an edited roster, including one edited down to empty', async () => {
    await renderTab();
    await screen.findByText('Fix the save path');

    fireEvent.click(screen.getByRole('button', { name: /Reviewer override/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Remove codex$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Resolve & merge' }));

    await waitFor(() => expect(api.resolveAppPullRequest).toHaveBeenCalled());
    expect(api.resolveAppPullRequest.mock.calls[0][2]).toMatchObject({ reviewers: [] });
  });

  // The picker emits a partial against its baseline, so editing a field back to
  // the default empties that partial — the override has to disappear with it,
  // or the panel keeps claiming an override the run no longer has.
  it('drops the override once every edit is undone', async () => {
    await renderTab();
    await screen.findByText('Fix the save path');

    fireEvent.click(screen.getByRole('button', { name: /Reviewer override/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Remove codex$/i }));
    expect(screen.getByRole('button', { name: /Reviewer override \(active\)/ })).toBeInTheDocument();

    fireEvent.click(screen.getByText('Standalone / legacy backend'));
    fireEvent.change(screen.getByLabelText('Legacy backend'), { target: { value: 'codex' } });
    fireEvent.click(screen.getByText('Add legacy reviewer'));
    expect(screen.getByRole('button', { name: /^Reviewer override$/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Resolve & merge' }));
    await waitFor(() => expect(api.resolveAppPullRequest).toHaveBeenCalled());
    expect(api.resolveAppPullRequest.mock.calls[0][2]).not.toHaveProperty('reviewers');
  });

  // A picker whose every edit would be discarded reads as a setting being
  // ignored, so self-review hides it rather than disabling it.
  it('hides the reviewer override under self-review', async () => {
    await renderTab();
    await screen.findByText('Fix the save path');

    expect(screen.getByRole('button', { name: /Reviewer override/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Code review'), { target: { value: 'self' } });
    expect(screen.queryByRole('button', { name: /Reviewer override/ })).not.toBeInTheDocument();
  });
});
