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

vi.mock('../../services/api', () => api);
vi.mock('../../services/socket', () => ({ default: socket }));

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

  it('keeps the newest reload when an earlier one answers last', async () => {
    api.getGitHubAutomationActivity.mockResolvedValueOnce({ actions: [] });
    renderTab();
    await screen.findByText(/have not acted on anything yet/);

    const older = deferred();
    const newer = deferred();
    api.getGitHubAutomationActivity.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    act(() => { socket.handlers['github:notifications:changed'](); });
    act(() => { socket.handlers['github:notifications:changed'](); });

    await act(async () => { newer.resolve({ actions: [action(2, 'Newest action')] }); });
    await screen.findByText('Newest action');
    await act(async () => { older.resolve({ actions: [] }); });

    await waitFor(() => expect(screen.getByText('Newest action')).toBeTruthy());
    expect(screen.queryByText(/have not acted on anything yet/)).toBeNull();
  });
});
