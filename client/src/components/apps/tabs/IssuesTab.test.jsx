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
    emit: vi.fn()
  };
  return { socketHandlers: handlers, socketMock: mock };
});

vi.mock('../../../services/socket', () => ({ default: socketMock }));

vi.mock('../../../services/api', () => ({
  getAppIssues: vi.fn(),
  createSlashdoTask: vi.fn(),
  getProviders: vi.fn(),
}));

import * as api from '../../../services/api';
import IssuesTab from './IssuesTab';

const ISSUE = {
  number: 42,
  title: 'Crash on save',
  body: 'Repro: open the editor and hit save.',
  url: 'https://github.com/acme/widget/issues/42',
  state: 'open',
  labels: [{ name: 'bug', color: '#d73a4a', description: 'Something is broken' }],
  assignees: ['alice'],
  author: 'carol',
  milestone: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const okPayload = (issues) => ({
  forge: 'github',
  fullName: 'acme/widget',
  issues,
  reason: issues.length ? 'ok' : 'no-open-issues',
  transient: false,
  remedy: null,
});

const renderTab = async () => {
  const result = render(
    <MemoryRouter>
      <IssuesTab appId="app-1" appName="Widget" />
    </MemoryRouter>
  );
  await act(async () => {});
  return result;
};

beforeEach(() => {
  socketHandlers.clear();
  socketMock.on.mockClear();
  socketMock.off.mockClear();
  socketMock.emit.mockClear();
  api.getAppIssues.mockResolvedValue(okPayload([ISSUE]));
  api.createSlashdoTask.mockResolvedValue({ id: 'task-1' });
  api.getProviders.mockResolvedValue({ providers: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('IssuesTab', () => {
  it('auto-queries open issues on mount and renders title, labels, and assignees', async () => {
    await renderTab();

    expect(await screen.findByText('Crash on save')).toBeInTheDocument();
    expect(api.getAppIssues).toHaveBeenCalledWith('app-1');
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getByText('bug')).toBeInTheDocument();
    expect(screen.getByText(/alice/)).toBeInTheDocument();
    expect(screen.getByText('acme/widget')).toBeInTheDocument();
  });

  it('keeps the description collapsed until the user expands it', async () => {
    await renderTab();

    const title = await screen.findByText('Crash on save');
    expect(screen.queryByText(/Repro: open the editor/)).not.toBeInTheDocument();

    fireEvent.click(title);
    expect(await screen.findByText(/Repro: open the editor/)).toBeInTheDocument();

    fireEvent.click(title);
    await waitFor(() => expect(screen.queryByText(/Repro: open the editor/)).not.toBeInTheDocument());
  });

  it('claims an issue with its prefetched content pinned to the /do:next task', async () => {
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Claim/ }));

    await waitFor(() => expect(api.createSlashdoTask).toHaveBeenCalledWith(
      'next', 'app-1', {
        target: '42',
        issueContext: {
          number: 42,
          title: 'Crash on save',
          body: 'Repro: open the editor and hit save.',
          url: 'https://github.com/acme/widget/issues/42'
        }
      }, { silent: true }
    ));
    expect(await screen.findByRole('link', { name: /Queued/ })).toBeInTheDocument();
  });

  it('tracks the claimed task from queued through active and completed over the CoS socket', async () => {
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Claim/ }));
    expect(await screen.findByRole('link', { name: /Queued/ })).toBeInTheDocument();

    act(() => socketHandlers.get('cos:tasks:changed')({
      task: { id: 'task-1', status: 'in_progress' }
    }));
    expect(await screen.findByRole('link', { name: /Active/ })).toBeInTheDocument();

    act(() => socketHandlers.get('cos:tasks:changed')({
      task: { id: 'task-1', status: 'completed' }
    }));
    expect(await screen.findByRole('link', { name: /Completed/ })).toBeInTheDocument();
  });

  it('does not lose an active socket update that arrives before the POST response', async () => {
    let resolveClaim;
    api.createSlashdoTask.mockImplementation(() => new Promise(resolve => { resolveClaim = resolve; }));
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Claim/ }));
    act(() => socketHandlers.get('cos:tasks:changed')({
      task: {
        id: 'task-1', status: 'in_progress',
        metadata: { app: 'app-1', claimTarget: '42' }
      }
    }));
    expect(await screen.findByRole('link', { name: /Active/ })).toBeInTheDocument();

    await act(async () => {
      resolveClaim({ id: 'task-1', status: 'pending' });
    });
    expect(screen.getByRole('link', { name: /Active/ })).toBeInTheDocument();
  });

  it('sends the page-level provider/model/effort pin along with a claim', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'claude', name: 'Claude', type: 'cli', enabled: true,
        models: ['claude-opus-5', 'claude-sonnet-5'], defaultModel: 'claude-sonnet-5',
      }],
    });
    await renderTab();

    await screen.findByText('Crash on save');
    fireEvent.change(await screen.findByLabelText('Provider'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-opus-5' } });

    fireEvent.click(screen.getByRole('button', { name: /Claim/ }));

    await waitFor(() => expect(api.createSlashdoTask).toHaveBeenCalledWith(
      'next', 'app-1',
      {
        target: '42',
        issueContext: {
          number: 42,
          title: 'Crash on save',
          body: 'Repro: open the editor and hit save.',
          url: 'https://github.com/acme/widget/issues/42'
        },
        provider: 'claude',
        model: 'claude-opus-5',
        effort: undefined
      },
      { silent: true }
    ));
  });

  it('sends optional override context with the selected claim', async () => {
    await renderTab();

    await screen.findByText('Crash on save');
    fireEvent.change(screen.getByLabelText(/Override context or instructions/), {
      target: { value: 'Prefer a small, focused fix and add a regression test.' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Claim/ }));

    await waitFor(() => expect(api.createSlashdoTask).toHaveBeenCalledWith(
      'next', 'app-1',
      expect.objectContaining({
        target: '42',
        overrideContext: 'Prefer a small, focused fix and add a regression test.'
      }),
      { silent: true }
    ));
  });

  it('re-enables the Claim button when queuing fails, instead of stranding it', async () => {
    api.createSlashdoTask.mockRejectedValue(new Error('CoS is not running'));
    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Claim/ }));

    await waitFor(() => expect(screen.getByRole('button', { name: /Claim/ })).toBeEnabled());
    expect(screen.queryByRole('link', { name: /Queued/ })).not.toBeInTheDocument();
  });

  it('filters the list by title, label, or assignee', async () => {
    api.getAppIssues.mockResolvedValue(okPayload([
      ISSUE,
      { ...ISSUE, number: 43, title: 'Add CSV export', labels: [], assignees: [] },
    ]));
    await renderTab();

    await screen.findByText('Crash on save');
    fireEvent.change(screen.getByLabelText('Filter issues'), { target: { value: 'csv' } });

    expect(screen.getByText('Add CSV export')).toBeInTheDocument();
    expect(screen.queryByText('Crash on save')).not.toBeInTheDocument();
  });

  it('ignores a stale in-flight response when the app changes mid-request', async () => {
    // Switching apps updates this component in place, so a slow first response
    // must not land on top of the newer app's list.
    let resolveFirst;
    api.getAppIssues
      .mockImplementationOnce(() => new Promise(res => { resolveFirst = res; }))
      .mockResolvedValueOnce(okPayload([{ ...ISSUE, number: 99, title: 'Second app issue' }]));

    const { rerender } = render(
      <MemoryRouter><IssuesTab appId="app-1" appName="Widget" /></MemoryRouter>
    );
    rerender(
      <MemoryRouter><IssuesTab appId="app-2" appName="Other" /></MemoryRouter>
    );
    await act(async () => {});
    expect(await screen.findByText('Second app issue')).toBeInTheDocument();

    // The first app's response arrives late — it must be discarded.
    resolveFirst(okPayload([ISSUE]));
    await waitFor(() => expect(screen.getByText('Second app issue')).toBeInTheDocument());
    expect(screen.queryByText('Crash on save')).not.toBeInTheDocument();
  });

  it('says "couldn\'t reach" for a transient failure — never "no open issues"', async () => {
    api.getAppIssues.mockResolvedValue({
      forge: 'github', fullName: 'acme/widget', issues: [],
      reason: 'gh-unauthenticated', transient: true, remedy: 'run gh auth login',
    });
    await renderTab();

    expect(await screen.findByText(/Couldn't reach GitHub/)).toBeInTheDocument();
    expect(screen.getByText(/run gh auth login/)).toBeInTheDocument();
    expect(screen.queryByText(/No open issues on this tracker/)).not.toBeInTheDocument();
  });

  it('explains a non-forge origin instead of showing an empty list', async () => {
    api.getAppIssues.mockResolvedValue({
      forge: null, fullName: null, issues: [], reason: 'unsupported-forge', transient: false, remedy: null,
    });
    await renderTab();

    expect(await screen.findByText(/isn't GitHub or GitLab/)).toBeInTheDocument();
  });

  it('points at the Work Tracker setting when the tracker owns no forge issues', async () => {
    // The server refuses to list issues a Claim here would not actually touch.
    api.getAppIssues.mockResolvedValue({
      forge: null, tracker: 'jira', fullName: null, issues: [],
      reason: 'tracker-not-a-forge', transient: false, remedy: null,
    });
    await renderTab();

    expect(await screen.findByText(/Work Tracker isn't a forge issue tracker/)).toBeInTheDocument();
    // No issues ⇒ no Claim button that would queue a mis-routed run.
    expect(screen.queryByRole('button', { name: /Claim/ })).not.toBeInTheDocument();
  });
});
