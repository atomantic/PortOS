import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  deleteGitHubLearnedRule: vi.fn(),
  getGitHubAutomationActivity: vi.fn(),
  getGitHubAutomations: vi.fn(),
  getGitHubLearnedRules: vi.fn(),
  setGitHubNotificationCadence: vi.fn(),
  syncGitHubNotifications: vi.fn(),
  undoGitHubAutomationAction: vi.fn(),
  updateGitHubAccount: vi.fn(),
}));
const socket = vi.hoisted(() => ({ handlers: {}, on: vi.fn(), off: vi.fn() }));
socket.on.mockImplementation((event, handler) => { socket.handlers[event] = handler; });

vi.mock('../../services/apiGithub.js', () => ({
  deleteGitHubLearnedRule: api.deleteGitHubLearnedRule,
  getGitHubAutomationActivity: api.getGitHubAutomationActivity,
  getGitHubAutomations: api.getGitHubAutomations,
  getGitHubLearnedRules: api.getGitHubLearnedRules,
  setGitHubNotificationCadence: api.setGitHubNotificationCadence,
  syncGitHubNotifications: api.syncGitHubNotifications,
  undoGitHubAutomationAction: api.undoGitHubAutomationAction,
  updateGitHubAccount: api.updateGitHubAccount,
}));
vi.mock('../../services/socket', () => ({ default: socket }));
// The rules editor loads the provider catalog on mount; out of scope here.
vi.mock('../../hooks/useRunWithPicker', () => ({ default: () => ({ providers: [] }) }));

const GitHubAutomationsTab = (await import('./GitHubAutomationsTab')).default;

const overview = { cadence: 'off', accounts: [], lastSummary: null };
const action = (id, title) => ({
  id, title, accountId: 'acct-1', threadId: `t-${id}`, action: 'done', repoFullName: 'example/repo', at: new Date().toISOString(), undoable: true,
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const renderTab = () => render(<MemoryRouter><GitHubAutomationsTab /></MemoryRouter>);

describe('GitHubAutomationsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socket.handlers = {};
    api.getGitHubAutomations.mockResolvedValue(overview);
    api.getGitHubLearnedRules.mockResolvedValue({ rules: [] });
  });

  it('shows a failed activity read as an error with Retry, not as "nothing yet"', async () => {
    api.getGitHubAutomationActivity.mockRejectedValueOnce(new Error('offline'));
    api.getGitHubLearnedRules.mockRejectedValueOnce(new Error('offline'));
    renderTab();

    expect(await screen.findByText(/Could not load recent actions/)).toBeTruthy();
    expect(screen.getByText(/Could not load learned rules/)).toBeTruthy();
    expect(screen.queryByText(/have not acted on anything yet/)).toBeNull();
    expect(screen.queryByText(/None yet\. When you handle/)).toBeNull();

    api.getGitHubAutomationActivity.mockResolvedValue({ actions: [action(1, 'Fix flaky test')] });
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);

    expect(await screen.findByText('Fix flaky test')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Undo/ })).toBeTruthy();
    expect(screen.queryByText(/Could not load recent actions/)).toBeNull();
  });

  it('drops a read that a newer change made obsolete and shows the trailing read', async () => {
    api.getGitHubAutomationActivity.mockResolvedValueOnce({ actions: [] });
    renderTab();
    await screen.findByText(/have not acted on anything yet/);

    const older = deferred();
    const newer = deferred();
    api.getGitHubAutomationActivity.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    await act(async () => { socket.handlers['github:notifications:changed'](); });
    await waitFor(() => expect(api.getGitHubAutomationActivity).toHaveBeenCalledTimes(2));
    await act(async () => { socket.handlers['github:notifications:changed'](); });

    // useSocketResource single-flights: the burst's trailing read starts once
    // the active (now obsolete) read settles, and only it may write.
    await act(async () => { older.resolve({ actions: [] }); });
    await act(async () => { newer.resolve({ actions: [action(2, 'Newest action')] }); });
    await screen.findByText('Newest action');

    await waitFor(() => expect(screen.getByText('Newest action')).toBeTruthy());
    expect(screen.queryByText(/have not acted on anything yet/)).toBeNull();
  });
  describe('Run now gating', () => {
    const account = (over = {}) => ({
      id: 'acct-1', label: 'Example', host: 'github.com', enabled: true, mode: 'observe',
      needsYou: 0, pending: 0, suspect: 0, agentRules: [], ...over,
    });
    const withAccount = (over) => {
      api.getGitHubAutomations.mockResolvedValue({ ...overview, accounts: [account(over)] });
      api.getGitHubAutomationActivity.mockResolvedValue({ actions: [] });
    };

    it('blocks Run now with a visible reason while a mode save is in flight, then re-enables', async () => {
      withAccount();
      const save = deferred();
      api.updateGitHubAccount.mockReturnValue(save.promise);
      renderTab();
      const run = await screen.findByRole('button', { name: 'Run now' });
      expect(run.disabled).toBe(false);

      fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'assist' } });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Run now' }).disabled).toBe(true));
      expect(screen.getAllByText('Saving changes…').length).toBeGreaterThan(0);

      await act(async () => { save.resolve(account({ mode: 'assist' })); });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Run now' }).disabled).toBe(false));
      expect(screen.queryByText('Saving changes…')).toBeNull();
    });

    it('blocks Run now with a reason when the account mode is disabled', async () => {
      withAccount({ mode: 'disabled' });
      renderTab();
      const run = await screen.findByRole('button', { name: 'Run now' });
      expect(run.disabled).toBe(true);
      expect(screen.getByText(/Choose a mode other than Disabled/)).toBeTruthy();
    });
  });
});
