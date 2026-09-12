import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getMessageSelectors: vi.fn(),
  syncMessageAccount: vi.fn(),
  testMessageSelectors: vi.fn(),
  addCosTask: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), {
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));
const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }));

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: toast }));
vi.mock('../../services/socket', () => ({ default: socket }));

const SyncTab = (await import('./SyncTab')).default;

const renderTab = () => render(<SyncTab accounts={[]} onRefresh={vi.fn()} />);

beforeEach(() => {
  vi.clearAllMocks();
  api.getMessageSelectors.mockResolvedValue({});
});

describe('SyncTab DOM selector test', () => {
  it('reports success with no investigate button when every selector matches', async () => {
    api.testMessageSelectors.mockResolvedValue({
      provider: 'teams',
      status: 'ok',
      results: { messageItem: { selector: "[role='listitem']", matches: 8 } },
    });
    renderTab();

    fireEvent.click(screen.getAllByText('Test')[1]); // teams card

    await waitFor(() => expect(screen.getByText(/all selectors matched/i)).toBeTruthy());
    expect(toast.success).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /queue agent to investigate/i })).toBeNull();
  });

  it('reports failure and offers to queue an investigation agent', async () => {
    api.testMessageSelectors.mockResolvedValue({
      provider: 'outlook',
      status: 'no-browser',
      results: {},
      error: 'Failed to open a browser tab — is portos-browser running?',
    });
    renderTab();

    fireEvent.click(screen.getAllByText('Test')[0]); // outlook card

    await waitFor(() => expect(screen.getByText(/no browser tab available/i)).toBeTruthy());
    expect(toast.error).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /queue agent to investigate/i })).toBeTruthy();
  });

  it('queues a CoS investigation task naming the failing provider and status', async () => {
    api.testMessageSelectors.mockResolvedValue({
      provider: 'outlook',
      status: 'partial',
      results: { messageRow: { selector: "[role='listbox'] [role='option']", matches: 0 } },
    });
    api.addCosTask.mockResolvedValue({ id: 'task-1' });
    renderTab();

    fireEvent.click(screen.getAllByText('Test')[0]);
    await waitFor(() => expect(screen.getByText(/some selectors matched zero elements/i)).toBeTruthy());
    expect(screen.getByText(/messageRow: 0 matches/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /queue agent to investigate/i }));

    await waitFor(() => expect(api.addCosTask).toHaveBeenCalledTimes(1));
    const [task, options] = api.addCosTask.mock.calls[0];
    expect(task.isInvestigation).toBe(true);
    expect(task.description).toMatch(/outlook/i);
    expect(task.prompt).toContain('partial');
    expect(options).toEqual({ silent: true });
    await waitFor(() => expect(screen.getByRole('button', { name: /agent queued/i })).toBeTruthy());
  });
});


describe('Messages sync lifecycle', () => {
  const account = { id: 'message-1', name: 'Inbox', enabled: true, provider: 'playwright' };
  const emit = (event, payload = {}) => act(() => {
    const handler = socket.on.mock.calls.find(([name]) => name === `messages:sync:${event}`)?.[1];
    handler?.({ accountId: account.id, ...payload });
  });

  it('releases provider failures without a dedicated event and preserves login guidance', async () => {
    render(<SyncTab accounts={[account]} onRefresh={vi.fn()} />);
    for (const status of ['no-browser', 'extraction-failed', 'unexpected-status']) {
      emit('started');
      expect(screen.queryByRole('button', { name: 'Sync Unread' })).toBeNull();
      emit('completed', { status });
      expect(screen.getByRole('button', { name: 'Sync Unread' })).toBeEnabled();
    }
    expect(toast.error).toHaveBeenCalledTimes(3);
    expect(toast.success).not.toHaveBeenCalled();
    emit('started');
    emit('auth-required');
    emit('completed', { status: 'auth-required' });
    expect(screen.getByText('Auth required')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Launch' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Sync Unread' })).toBeEnabled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('open Browser page'));
    await waitFor(() => expect(api.getMessageSelectors).toHaveBeenCalled());
  });

  it('reports a socket-first success once and a later manual rejection once', async () => {
    let resolve;
    api.syncMessageAccount.mockImplementation(() => new Promise(done => { resolve = done; }));
    const onRefresh = vi.fn();
    render(<SyncTab accounts={[account]} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Full Sync' }));
    expect(api.syncMessageAccount).toHaveBeenCalledWith(account.id, 'full', { silent: true });
    emit('started');
    emit('completed', { status: 'success', newMessages: 5 });
    await act(async () => resolve({ status: 'success', newMessages: 5 }));
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('Sync complete: 5 new messages');
    expect(onRefresh).toHaveBeenCalledTimes(1);

    api.syncMessageAccount.mockRejectedValue(new Error('Connection lost'));
    fireEvent.click(screen.getByRole('button', { name: 'Sync Unread' }));
    emit('started');
    emit('failed', { error: 'Connection lost' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sync Unread' })).toBeEnabled());
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Sync failed: Connection lost');
  });
});
