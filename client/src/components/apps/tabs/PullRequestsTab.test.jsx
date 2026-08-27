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

vi.mock('../../../services/socket', () => ({ default: socketMock }));
vi.mock('../../../services/api', () => ({
  getAppPullRequests: vi.fn(),
  resolveAppPullRequest: vi.fn(),
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
  });
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

  it('queues a review-loop resolve action and shows its task state', async () => {
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Resolve & merge/ }));

    await waitFor(() => expect(api.resolveAppPullRequest).toHaveBeenCalledWith('app-1', 17));
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

  it('hydrates an active server-side resolve action without offering another button', async () => {
    api.getAppPullRequests.mockResolvedValue(okPayload([{
      ...PULL_REQUEST,
      agentAction: { taskId: 'task-active', status: 'in_progress' },
    }]));

    await renderTab();

    expect(await screen.findByRole('link', { name: /Active/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Resolve & merge/ })).not.toBeInTheDocument();
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
});
