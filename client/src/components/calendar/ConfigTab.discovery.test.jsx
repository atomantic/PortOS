import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ConfigTab from './ConfigTab';

vi.mock('../../services/api', async () => import('../../services/apiCalendar.js'));
vi.mock('../FeatureProviderPicker', () => ({ default: () => null }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: toast }));

const account = {
  id: 'example-account', name: 'Example Calendar', type: 'google-calendar', enabled: true,
};
const existing = { calendarId: 'example-existing', name: 'Existing Calendar', enabled: true };
const discovered = { calendarId: 'example-new', name: 'Discovered Calendar', enabled: true };
const response = (body, status = 200) => ({
  ok: status < 400, status, json: async () => body,
});
let fetchMock;
let authResponse;
let discoveryResponse;

beforeEach(() => {
  vi.clearAllMocks();
  authResponse = Promise.resolve(response({ hasCredentials: true, hasTokens: true }));
  discoveryResponse = Promise.resolve(response({ calendars: [discovered] }));
  fetchMock = vi.fn((url) => url === '/api/calendar/google/auth/status'
    ? authResponse : discoveryResponse);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function renderAccount(extra = {}) {
  function Harness() {
    const [accounts, setAccounts] = useState([{ ...account, ...extra }]);
    return <ConfigTab accounts={accounts} setAccounts={setAccounts} />;
  }
  render(<MemoryRouter><Harness /></MemoryRouter>);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Expand calendars for Example Calendar' }));
}

const discoveryCalls = () => fetchMock.mock.calls.filter(([, options]) => options.method === 'POST');

describe('Calendar Config discovery method', () => {
  // Auth availability must never redirect a user-selected API action to a CLI provider.
  it.each(['present', 'absent', 'pending', 'failed'])('keeps Google API discovery when auth status is %s', async status => {
    let settleAuth;
    if (status === 'absent') authResponse = Promise.resolve(response({ hasCredentials: true, hasTokens: false }));
    if (status === 'pending') authResponse = new Promise(resolve => { settleAuth = resolve; });
    if (status === 'failed') authResponse = Promise.resolve(response({ error: 'Auth status unavailable' }, 503));
    await renderAccount({ syncMethod: 'google-api' });
    expect(screen.getByRole('combobox', { name: 'Sync method' })).toHaveValue('google-api');

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Discover Calendars' })));

    expect(discoveryCalls()).toEqual([[
      '/api/calendar/sync/example-account/discover-api',
      expect.objectContaining({ method: 'POST' }),
    ]]);
    expect(screen.getByText('Discovered Calendar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    if (settleAuth) await act(async () => settleAuth(response({ hasTokens: false })));
  });

  it.each(['claude-mcp', undefined])('retains MCP discovery for method %s', async syncMethod => {
    await renderAccount({ syncMethod });
    expect(screen.getByRole('combobox', { name: 'Sync method' })).toHaveValue('claude-mcp');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Discover Calendars' })));
    expect(discoveryCalls()).toEqual([[
      '/api/calendar/sync/example-account/discover',
      expect.objectContaining({ method: 'POST' }),
    ]]);
    expect(screen.getByText('Discovered Calendar')).toBeInTheDocument();
  });

  it('preserves calendars on API auth failure, reports it once, and releases discovery for retry', async () => {
    authResponse = Promise.resolve(response({ hasCredentials: true, hasTokens: false }));
    let failDiscovery;
    discoveryResponse = new Promise(resolve => { failDiscovery = resolve; });
    await renderAccount({ syncMethod: 'google-api', subcalendars: [existing] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByRole('button', { name: 'Discovering...' })).toBeDisabled();
    expect(screen.getByText('Existing Calendar')).toBeInTheDocument();

    await act(async () => failDiscovery(response({ error: 'Google OAuth not configured. Authorize Google first.' }, 400)));

    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Google OAuth not configured. Authorize Google first.');
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByText('Existing Calendar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    expect(discoveryCalls()[0][0]).toBe('/api/calendar/sync/example-account/discover-api');

    discoveryResponse = Promise.resolve(response({ calendars: [discovered] }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh' })));
    expect(screen.queryByText('Existing Calendar')).toBeNull();
    expect(screen.getByText('Discovered Calendar')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('Discovered 1 calendars');
    expect(discoveryCalls().map(([url]) => url)).toEqual([
      '/api/calendar/sync/example-account/discover-api',
      '/api/calendar/sync/example-account/discover-api',
    ]);
  });
});
