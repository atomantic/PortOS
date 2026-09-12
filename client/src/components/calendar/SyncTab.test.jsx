import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SyncTab from './SyncTab';

const api = vi.hoisted(() => ({
  getCalendarTokenStatus: vi.fn(),
  syncCalendarAccount: vi.fn(),
  apiSyncGoogleCalendar: vi.fn(),
  mcpSyncGoogleCalendar: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
const listeners = vi.hoisted(() => new Map());
vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: toast }));
vi.mock('../../services/socket', () => ({ default: {
  on: (event, handler) => listeners.set(event, handler),
  off: (event, handler) => { if (listeners.get(event) === handler) listeners.delete(event); },
} }));

const account = { id: 'calendar-1', name: 'Calendar', enabled: true, type: 'outlook-calendar' };
const emit = (event, payload = {}) => act(() => listeners.get(`calendar:sync:${event}`)?.({ accountId: account.id, ...payload }));
const syncButton = () => screen.getByRole('button', { name: 'Sync' });

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  api.getCalendarTokenStatus.mockResolvedValue({ providers: [] });
});

describe('Calendar sync lifecycle', () => {
  it('releases failed and partial syncs without claiming success, then accepts a new legacy success', async () => {
    const onRefresh = vi.fn();
    render(<SyncTab accounts={[account]} onRefresh={onRefresh} />);
    emit('started');
    expect(screen.queryByRole('button', { name: 'Sync' })).toBeNull();
    emit('completed', { status: 'api-error' });
    expect(syncButton()).toBeEnabled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('provider API'));
    expect(toast.success).not.toHaveBeenCalled();

    emit('started');
    emit('completed', { status: 'partial', reason: 'One calendar was unavailable', newEvents: 2 });
    expect(syncButton()).toBeEnabled();
    expect(toast.warning).toHaveBeenCalledWith('Calendar sync incomplete: One calendar was unavailable');
    expect(toast.success).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    emit('started');
    emit('completed', { newEvents: 3 });
    expect(toast.success).toHaveBeenCalledWith('Calendar sync complete: 3 events');
    expect(onRefresh).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(api.getCalendarTokenStatus).toHaveBeenCalled());
  });

  it('explains an HTTP-only skipped sync and deduplicates HTTP-first completion', async () => {
    api.syncCalendarAccount.mockResolvedValue({ status: 'skipped' });
    render(<SyncTab accounts={[account]} onRefresh={vi.fn()} />);
    fireEvent.click(syncButton());
    await waitFor(() => expect(syncButton()).toBeEnabled());
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('no usable token'));
    expect(api.syncCalendarAccount).toHaveBeenCalledWith(account.id, { silent: true });

    api.syncCalendarAccount.mockResolvedValue({ status: 'success', newEvents: 4 });
    fireEvent.click(syncButton());
    emit('started');
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    emit('completed', { status: 'success', newEvents: 4 });
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('ignores an older HTTP result after a newer socket cycle starts', async () => {
    let resolve;
    api.syncCalendarAccount.mockImplementation(() => new Promise(done => { resolve = done; }));
    render(<SyncTab accounts={[account]} onRefresh={vi.fn()} />);
    fireEvent.click(syncButton());
    emit('started');
    emit('completed', { status: 'success', newEvents: 1 });
    emit('started');
    await act(async () => resolve({ status: 'success', newEvents: 1 }));
    expect(screen.queryByRole('button', { name: 'Sync' })).toBeNull();
    expect(toast.success).toHaveBeenCalledTimes(1);
    emit('completed', { status: 'push-only' });
    expect(syncButton()).toBeEnabled();
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('pushed updates'));
  });

  it('clears Google progress on HTTP failure and removes listeners before a late response', async () => {
    const onRefresh = vi.fn();
    api.apiSyncGoogleCalendar.mockRejectedValue(new Error('Google OAuth not configured'));
    let resolve;
    api.mcpSyncGoogleCalendar.mockImplementation(() => new Promise(done => { resolve = done; }));
    const { rerender, unmount } = render(<SyncTab accounts={[{ ...account, type: 'google-calendar', syncMethod: 'google-api' }]} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sync (API)' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Google OAuth not configured')));
    expect(screen.getByRole('button', { name: 'Sync (API)' })).toBeEnabled();
    expect(screen.queryByText('Starting Google Calendar sync...')).toBeNull();

    rerender(<SyncTab accounts={[{ ...account, type: 'google-calendar' }]} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sync (Claude)' }));
    emit('started');
    emit('progress', { message: 'Fetching calendars' });
    expect(screen.getByText('Fetching calendars')).toBeTruthy();
    unmount();
    expect(listeners.size).toBe(0);
    await act(async () => resolve({ status: 'success', newEvents: 9 }));
    expect(toast.success).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
