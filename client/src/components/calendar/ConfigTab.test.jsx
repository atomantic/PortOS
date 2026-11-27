import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ConfigTab from './ConfigTab';

const api = vi.hoisted(() => ({
  getGoogleAuthStatus: vi.fn(),
  clearGoogleAuth: vi.fn(),
  deleteCalendarAccount: vi.fn(),
  updateSubcalendars: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../../services/apiCalendar.js', () => ({
  getGoogleAuthStatus: api.getGoogleAuthStatus,
  clearGoogleAuth: api.clearGoogleAuth,
  deleteCalendarAccount: api.deleteCalendarAccount,
  updateSubcalendars: api.updateSubcalendars,
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
  it('requires inline confirmation before clearing Google auth and allows cancel', async () => {
    const button = await openAuth();
    fireEvent.click(button);
    expect(screen.getByText(/Clear Google API authorization\?/)).toBeTruthy();
    expect(api.clearGoogleAuth).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Clear Google API authorization\?/)).toBeNull();
    expect(api.clearGoogleAuth).not.toHaveBeenCalled();
    expect(screen.getByText('Google API authenticated')).toBeTruthy();
  });

  it('blocks duplicate clears and confirms a bodyless success before refreshing auth', async () => {
    let resolve;
    api.clearGoogleAuth.mockImplementation(() => new Promise(done => { resolve = done; }));
    const button = await openAuth();
    api.getGoogleAuthStatus.mockResolvedValue({ hasCredentials: true, hasTokens: false });
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'Clear auth' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Clear auth' }));
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByText('Google API authenticated')).toBeTruthy();
    expect(api.getGoogleAuthStatus).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled(); // API request owns the error notice.

    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'Clear auth' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Delete account Example Calendar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith('Filesystem operation failed'));
    expect(screen.getByText('Example Calendar')).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete account Example Calendar' }));
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

describe('subcalendar color', () => {
  const subcalendar = { calendarId: 'example', name: 'Work', enabled: true, color: '#112233' };

  async function openColorPicker() {
    function Harness() {
      const [accounts, setAccounts] = useState([{ ...account, subcalendars: [subcalendar] }]);
      return <ConfigTab accounts={accounts} setAccounts={setAccounts} />;
    }

    render(<MemoryRouter><Harness /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Expand calendars for Example Calendar' }));
    await screen.findByText('Google API authenticated');
    return screen.getByLabelText('Change color for Work');
  }

  it('previews input events and saves the final color once on blur', async () => {
    api.updateSubcalendars.mockImplementation(async (_id, body) => body);
    const picker = await openColorPicker();

    for (const value of ['#ff1000', '#ff2000', '#ff3000']) {
      await act(async () => fireEvent.input(picker, { target: { value } }));
      expect(picker).toHaveValue(value);
    }
    expect(api.updateSubcalendars).not.toHaveBeenCalled();

    await act(async () => fireEvent.blur(picker));
    expect(api.updateSubcalendars).toHaveBeenCalledExactlyOnceWith(
      account.id, { subcalendars: [{ ...subcalendar, color: '#ff3000' }] }, { silent: true },
    );
    await act(async () => fireEvent.blur(picker));
    expect(api.updateSubcalendars).toHaveBeenCalledTimes(1);
  });

  it('skips an unchanged blur and restores the last saved color on failure', async () => {
    api.updateSubcalendars.mockRejectedValue(new Error('Synthetic save failure'));
    const picker = await openColorPicker();

    await act(async () => fireEvent.blur(picker));
    expect(api.updateSubcalendars).not.toHaveBeenCalled();

    await act(async () => fireEvent.input(picker, { target: { value: '#ff1000' } }));
    await act(async () => fireEvent.input(picker, { target: { value: '#ff2000' } }));
    await act(async () => fireEvent.blur(picker));

    expect(picker).toHaveValue(subcalendar.color);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Failed to update subcalendars');
  });

  it.each([
    ['Disable Work', { enabled: false }],
    ['Dormant', { dormant: true }],
  ])('preserves the color when blur is followed by %s', async (name, fields) => {
    let finishColor;
    api.updateSubcalendars
      .mockImplementationOnce((_id, body) => new Promise(resolve => { finishColor = () => resolve(body); }))
      .mockImplementation(async (_id, body) => body);
    const picker = await openColorPicker();
    expect(picker.parentElement).toHaveClass(
      'focus-within:ring-2', 'focus-within:ring-port-accent', 'pointer-coarse:min-h-11', 'pointer-coarse:min-w-11',
    );
    const action = screen.getByRole('button', { name });
    expect(screen.getByRole('button', { name: 'Disable Work', pressed: true })).toBeEnabled();

    fireEvent.input(picker, { target: { value: '#ff1000' } });
    await act(async () => fireEvent.blur(picker));
    expect(api.updateSubcalendars).toHaveBeenCalledExactlyOnceWith(
      account.id, { subcalendars: [{ ...subcalendar, color: '#ff1000' }] }, { silent: true },
    );
    expect(action).toBeEnabled();
    await act(async () => fireEvent.click(action));
    expect(api.updateSubcalendars).toHaveBeenCalledTimes(1);

    await act(async () => finishColor());
    expect(api.updateSubcalendars).toHaveBeenNthCalledWith(
      2, account.id, { subcalendars: [{ ...subcalendar, color: '#ff1000', ...fields }] }, { silent: true },
    );
    expect(picker).toHaveValue('#ff1000');
  });

  it('continues with the last confirmed list when a queued save fails', async () => {
    let failColor;
    api.updateSubcalendars
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failColor = reject; }))
      .mockImplementation(async (_id, body) => body);
    const picker = await openColorPicker();
    fireEvent.input(picker, { target: { value: '#ff1000' } });
    await act(async () => fireEvent.blur(picker));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Disable Work' })));
    await act(async () => failColor(new Error('Synthetic save failure')));

    expect(api.updateSubcalendars).toHaveBeenNthCalledWith(
      2, account.id, { subcalendars: [{ ...subcalendar, enabled: false }] }, { silent: true },
    );
    expect(picker).toHaveValue(subcalendar.color);
    expect(screen.getByRole('button', { name: 'Enable Work', pressed: false })).toBeEnabled();
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Failed to update subcalendars');
  });

  it('still saves enable, dormant and activate actions immediately', async () => {
    api.updateSubcalendars.mockImplementation(async (_id, body) => body);
    await openColorPicker();

    for (const [index, name, fields] of [
      [1, 'Disable Work', { enabled: false }],
      [2, 'Enable Work', { enabled: true }],
      [3, 'Dormant', { dormant: true }],
      [4, 'Activate', { dormant: false }],
    ]) {
      const button = screen.getByRole('button', { name });
      await act(async () => fireEvent.click(button));
      expect(api.updateSubcalendars).toHaveBeenNthCalledWith(
        index, account.id, { subcalendars: [{ ...subcalendar, ...fields }] }, { silent: true },
      );
    }
  });
});
