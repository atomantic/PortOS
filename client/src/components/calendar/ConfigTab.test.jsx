import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ConfigTab from './ConfigTab';

const api = vi.hoisted(() => ({
  getGoogleAuthStatus: vi.fn(),
  clearGoogleAuth: vi.fn(),
  deleteCalendarAccount: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../../services/apiCalendar.js', () => ({
  getGoogleAuthStatus: api.getGoogleAuthStatus,
  clearGoogleAuth: api.clearGoogleAuth,
  deleteCalendarAccount: api.deleteCalendarAccount,
}));
vi.mock('../ui/Toast', () => ({ default: toast }));

const account = { id: 'google-1', name: 'Example Calendar', enabled: true, type: 'google-calendar', syncMethod: 'google-api' };

beforeEach(() => {
  vi.resetAllMocks();
  api.getGoogleAuthStatus.mockResolvedValue({ hasCredentials: true, hasTokens: true });
});
afterEach(() => vi.unstubAllGlobals());

const openAuth = async () => {
  render(<MemoryRouter><ConfigTab accounts={[account]} setAccounts={vi.fn()} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Expand calendars for Example Calendar' }));
  await screen.findByText('Google API authenticated');
  return screen.getByRole('button', { name: 'Clear' });
};

describe('Google API status read', () => {
  // A failed read must not fall through to the credential form and automated
  // setup, where saving would replace a working OAuth client.
  it('shows a failed status read with Retry instead of the setup flow', async () => {
    api.getGoogleAuthStatus
      .mockRejectedValueOnce(new Error('Synthetic status failure'))
      .mockResolvedValueOnce({ hasCredentials: true, hasTokens: true });
    render(<MemoryRouter><ConfigTab accounts={[account]} setAccounts={vi.fn()} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Expand calendars for Example Calendar' }));

    expect(await screen.findByText(/Could not load Google API authorization status/)).toBeTruthy();
    expect(screen.queryByText(/Connect directly to Google Calendar API/)).toBeNull();
    expect(api.getGoogleAuthStatus).toHaveBeenCalledWith({ silent: true });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Google API authenticated');
    expect(screen.queryByText(/Could not load Google API authorization status/)).toBeNull();
  });
});

describe('Google credential clearing', () => {
  it('blocks duplicate clears and confirms a bodyless success before refreshing auth', async () => {
    let resolve;
    api.clearGoogleAuth.mockImplementation(() => new Promise(done => { resolve = done; }));
    const button = await openAuth();
    api.getGoogleAuthStatus.mockResolvedValue({ hasCredentials: true, hasTokens: false });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(api.clearGoogleAuth).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(api.getGoogleAuthStatus).toHaveBeenCalledTimes(1);

    await act(async () => resolve(undefined));
    await screen.findByText('Credentials saved but not authorized yet.');
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('Google auth cleared');
    expect(api.getGoogleAuthStatus).toHaveBeenCalledTimes(2);
  });

  it('preserves authenticated status on rejection and releases Clear for retry', async () => {
    api.clearGoogleAuth.mockRejectedValueOnce(new Error('Synthetic clear failure')).mockResolvedValueOnce(undefined);
    const button = await openAuth();
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByText('Google API authenticated')).toBeTruthy();
    expect(api.getGoogleAuthStatus).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled(); // API request owns the error notice.

    fireEvent.click(button);
    await waitFor(() => expect(toast.success).toHaveBeenCalledExactlyOnceWith('Google auth cleared'));
    expect(api.clearGoogleAuth).toHaveBeenCalledTimes(2);
    expect(api.getGoogleAuthStatus).toHaveBeenCalledTimes(2);
  });
});

describe('calendar account deletion', () => {
  // Catches false success/removal on cleanup failure, a missing visible API
  // error, or bodyless retry success failing to remove the retained account.
  it('shows the API failure, retains the account, and lets deletion succeed on retry', async () => {
    const { deleteCalendarAccount } = await vi.importActual('../../services/apiCalendar.js');
    api.deleteCalendarAccount.mockImplementation(deleteCalendarAccount);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Filesystem operation failed', code: 'EACCES' }), { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    function Harness() {
      const [accounts, setAccounts] = useState([account]);
      return <MemoryRouter><ConfigTab accounts={accounts} setAccounts={setAccounts} /></MemoryRouter>;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith('Filesystem operation failed'));
    expect(screen.getByText('Example Calendar')).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('Example Calendar')).toBeNull());
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('Account deleted');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/calendar/accounts/${account.id}`, expect.objectContaining({ method: 'DELETE' }));
  });
});

describe('ConfigTab narrow-viewport layout', () => {
  it('applies flex-wrap and min-w-0 on account, sync-method, Google auth, and sub-calendar rows', async () => {
    const richAccount = {
      ...account,
      email: 'example.long.address@example.com',
      subcalendars: [{ calendarId: 'cal-1@example.com', name: 'Long Subcalendar Name', enabled: true }],
    };
    render(<MemoryRouter><ConfigTab accounts={[richAccount]} setAccounts={vi.fn()} /></MemoryRouter>);

    const accountName = screen.getByText('Example Calendar');
    const labelBlock = accountName.parentElement;
    expect(labelBlock.className).toContain('min-w-0');
    expect(labelBlock.parentElement.className).toContain('min-w-0');
    expect(labelBlock.parentElement.parentElement.className).toContain('flex-wrap');

    fireEvent.click(screen.getByRole('button', { name: 'Expand calendars for Example Calendar' }));
    const authText = await screen.findByText('Google API authenticated');
    expect(authText.parentElement.className).toContain('min-w-0');
    expect(authText.parentElement.parentElement.className).toContain('flex-wrap');

    const syncSelect = screen.getByLabelText('Sync method');
    expect(syncSelect.parentElement.className).toContain('flex-wrap');

    const subcalHeading = screen.getByText(/Sub-calendars/);
    expect(subcalHeading.parentElement.className).toContain('flex-wrap');

    const subcalName = screen.getByText('Long Subcalendar Name');
    expect(subcalName.parentElement.className).toContain('min-w-0');
    expect(subcalName.parentElement.parentElement.className).toContain('min-w-0');
    expect(subcalName.parentElement.parentElement.parentElement.className).toContain('flex-wrap');
  });
});
