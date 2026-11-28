import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import Calendar, { TABS } from './Calendar';
import socket from '../services/socket';

const api = vi.hoisted(() => ({
  getCalendarAccounts: vi.fn(),
  getCalendarEvents: vi.fn(),
  getCalendarTokenStatus: vi.fn(),
  getGoogleAuthStatus: vi.fn(),
  getDailyReview: vi.fn(),
  getChronotypeEnergySchedule: vi.fn(),
  syncCalendarAccount: vi.fn(),
}));
vi.mock('../services/apiCalendar.js', () => ({
  getCalendarAccounts: api.getCalendarAccounts,
  getCalendarEvents: api.getCalendarEvents,
  getCalendarTokenStatus: api.getCalendarTokenStatus,
  getGoogleAuthStatus: api.getGoogleAuthStatus,
  getDailyReview: api.getDailyReview,
  syncCalendarAccount: api.syncCalendarAccount,
}));
vi.mock('../services/apiGoals.js', () => ({ getChronotypeEnergySchedule: api.getChronotypeEnergySchedule }));
vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
// These independent features are outside the account-loading contract.
vi.mock('../components/FeatureProviderPicker', () => ({ default: () => null }));
vi.mock('../components/meatspace/tabs/CalendarTab', () => ({ default: () => <p>Lifetime content</p> }));

import { expectPageNavTabs } from '../test/pageNavTabAssertions.js';

// Calendar derives its tab bar from the nav manifest's `tabGroup: 'calendar'`
// (#6365) — this pins that TABS stays in sync (id, label, declaration order)
// and that every manifest tab has a presentation entry (icon) in Calendar.jsx,
// which would otherwise only surface as a thrown import-time error.
describe('Calendar TABS ↔ nav manifest', () => {
  it('renders the calendar tabGroup in page order with a presentation entry each', () => {
    expectPageNavTabs(TABS, [
      'agenda:Agenda', 'day:Day', 'week:Week', 'month:Month', 'lifetime:Lifetime', 'review:Review', 'sync:Sync', 'config:Config',
    ]);
  });
});

const account = { id: 'example-account', name: 'Example Calendar', type: 'outlook-calendar', enabled: true };

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current location">{location.pathname}{location.search}</output>;
}

function renderCalendar(entry = '/calendar/config', strict = false) {
  const page = <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/calendar/:tab" element={<><Calendar /><LocationProbe /></>} />
    </Routes>
  </MemoryRouter>;
  return render(strict ? <StrictMode>{page}</StrictMode> : page);
}

function selectTab(name) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

beforeEach(() => {
  vi.resetAllMocks();
  api.getCalendarEvents.mockResolvedValue({ events: [], total: 0 });
  api.getCalendarTokenStatus.mockResolvedValue({ providers: [] });
  api.getGoogleAuthStatus.mockResolvedValue(null);
  api.getDailyReview.mockResolvedValue({ events: [], total: 0, nextOffset: null, summary: { totalEvents: 0, confirmed: 0, skipped: 0, unreviewed: 0 } });
  api.getChronotypeEnergySchedule.mockResolvedValue(null);
});

describe('Calendar account availability', () => {
  it('keeps failed reads unavailable across tabs and retries in the selected URL context', async () => {
    api.getCalendarAccounts.mockRejectedValueOnce(new Error('Read unavailable'));
    renderCalendar('/calendar/config?from=2026-10-01');

    expect(await screen.findByRole('alert')).toHaveTextContent('Calendar accounts unavailable');
    expect(screen.queryByText('0 accounts')).toBeNull();
    expect(screen.queryByText('No calendar accounts configured')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add Account' })).toBeNull();
    for (const tab of ['Day', 'Week', 'Month', 'Review', 'Agenda', 'Sync']) {
      selectTab(tab);
      expect(screen.getByRole('alert')).toHaveTextContent('Calendar accounts unavailable');
      expect(screen.queryByText('No calendar connected')).toBeNull();
      expect(screen.queryByRole('link', { name: /calendar/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Sync/ })).toBeNull();
    }
    expect(api.getCalendarAccounts).toHaveBeenCalledTimes(1);
    selectTab('Config');
    api.getCalendarAccounts.mockResolvedValueOnce([account]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText(account.name)).toBeVisible();
    expect(screen.getByText('1 account')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add Account' })).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Current location')).toHaveTextContent('/calendar/config?from=2026-10-01');
    expect(api.getCalendarAccounts).toHaveBeenLastCalledWith({ silent: true });
  });

  it('reserves child setup guidance for a successful empty snapshot', async () => {
    api.getCalendarAccounts.mockResolvedValue([]);
    renderCalendar();

    expect(await screen.findByText('No calendar accounts configured')).toBeVisible();
    expect(screen.getByText('0 accounts')).toBeVisible();
    for (const tab of ['Day', 'Week', 'Month', 'Review', 'Agenda', 'Sync']) {
      selectTab(tab);
      await waitFor(() => expect(screen.getByText('No calendar connected')).toBeVisible());
    }
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('preserves a stale read-only snapshot after sync refresh fails, then replaces it on retry', async () => {
    let rejectRefresh;
    api.getCalendarAccounts.mockResolvedValueOnce([account])
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }));
    api.syncCalendarAccount.mockResolvedValue({ status: 'success', newEvents: 0 });
    renderCalendar('/calendar/sync?from=2026-10-01');

    fireEvent.click(await screen.findByRole('button', { name: 'Sync' }));
    await waitFor(() => expect(api.getCalendarAccounts).toHaveBeenCalledTimes(2));
    // A healthy refresh preserves the mounted sync view and its lifecycle.
    expect(screen.getByText(account.name)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sync' })).toBeEnabled();
    await act(async () => rejectRefresh(new Error('Refresh unavailable')));
    expect(await screen.findByRole('alert')).toHaveTextContent('snapshot is stale');
    expect(screen.getByText('1 account (last loaded)')).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Last loaded calendar accounts' })).getByText(account.name)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Sync' })).toBeNull();
    selectTab('Config');
    expect(screen.queryByRole('button', { name: 'Add Account' })).toBeNull();
    expect(screen.getByText(account.name)).toBeVisible();
    selectTab('Sync');

    let resolveRetry;
    api.getCalendarAccounts.mockImplementationOnce(() => new Promise(resolve => { resolveRetry = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
    expect(screen.getByText(account.name)).toBeVisible();
    await waitFor(() => expect(resolveRetry).toBeTypeOf('function'));
    const recovered = { ...account, id: 'recovered-account', name: 'Recovered Calendar' };
    await act(async () => resolveRetry([recovered]));

    expect(await screen.findByText(recovered.name)).toBeVisible();
    expect(screen.queryByText(account.name)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sync' })).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Current location')).toHaveTextContent('/calendar/sync?from=2026-10-01');
  });

  it('keeps independent Lifetime content and navigation available during a failed read', async () => {
    api.getCalendarAccounts.mockRejectedValue(new Error('Read unavailable'));
    renderCalendar('/calendar/lifetime');

    expect(await screen.findByText('Lifetime content')).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent('Calendar accounts unavailable');
    selectTab('Config');
    expect(screen.queryByText('No calendar accounts configured')).toBeNull();
    selectTab('Lifetime');
    expect(await screen.findByText('Lifetime content')).toBeVisible();
  });

  it('treats an invalid account response as unavailable rather than empty', async () => {
    api.getCalendarAccounts.mockResolvedValue(null);
    renderCalendar();

    expect(await screen.findByRole('alert')).toHaveTextContent('Calendar accounts unavailable');
    expect(screen.queryByText('0 accounts')).toBeNull();
    expect(screen.queryByText('No calendar accounts configured')).toBeNull();
  });

  it('reads once under StrictMode remounts and shows the snapshot without an alert', async () => {
    api.getCalendarAccounts.mockResolvedValue([account]);
    renderCalendar('/calendar/config', true);

    expect(await screen.findByText(account.name)).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('1 account')).toBeVisible();
  });
});

it('keeps all eight section tabs named when their labels collapse on phones', async () => {
  api.getCalendarAccounts.mockResolvedValue([]);
  renderCalendar();
  await screen.findByText('No calendar accounts configured');

  const sections = within(screen.getByRole('tablist', { name: 'Calendar sections' }));
  for (const name of ['Agenda', 'Day', 'Week', 'Month', 'Lifetime', 'Review', 'Sync', 'Config']) {
    const tab = sections.getByRole('tab', { name });
    expect(within(tab).getByText(name)).toHaveClass('max-sm:sr-only');
  }
});


it('reconciles configuration without replacing an edited form and ignores obsolete reads', async () => {
  let resolveOld;
  api.getCalendarAccounts.mockResolvedValueOnce([account])
    .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
    .mockResolvedValueOnce([{ ...account, name: 'Current calendar' }]);
  const mounted = renderCalendar();
  await screen.findByText(account.name);
  fireEvent.click(screen.getByRole('button', { name: 'Add Account' }));
  const input = screen.getByPlaceholderText('e.g. Work Calendar');
  fireEvent.change(input, { target: { value: 'Unsaved calendar' } });
  const changed = socket.on.mock.calls.find(([name]) => name === 'calendar:changed')[1];
  const reconnect = socket.on.mock.calls.find(([name]) => name === 'connect')[1];
  await act(async () => { changed(); });
  expect(input).toHaveValue('Unsaved calendar');
  await act(async () => { reconnect(); });
  // Reads are single-flight: the newer reconnect read runs after the obsolete one settles and wins.
  await act(async () => resolveOld([account]));
  expect(await screen.findByText('Current calendar')).toBeVisible();
  expect(screen.queryByText(account.name)).toBeNull();
  expect(input).toHaveValue('Unsaved calendar');
  mounted.unmount();
  expect(socket.off).toHaveBeenCalledWith('calendar:changed', changed);
  expect(socket.off).toHaveBeenCalledWith('connect', reconnect);
});


it('updates a mounted day grid color and removes events after configuration changes', async () => {
  const configured = { ...account, subcalendars: [{ calendarId: 'example-subcalendar', color: '#ff0000' }] };
  const now = new Date();
  now.setHours(10, 0, 0, 0);
  const meeting = { id: 'example-meeting', accountId: account.id, subcalendarId: 'example-subcalendar',
    title: 'Configured meeting', startTime: now.toISOString(), endTime: new Date(now.getTime() + 3600000).toISOString(), isAllDay: false };
  api.getCalendarAccounts.mockResolvedValue([configured]);
  api.getCalendarEvents.mockResolvedValue({ events: [meeting], total: 1 });
  renderCalendar('/calendar/day');
  const chip = await screen.findByRole('button', { name: /Configured meeting/ });
  const originalStyle = chip.getAttribute('style');
  const handlers = socket.on.mock.calls.filter(([name]) => name === 'calendar:changed').map(([, fn]) => fn);
  api.getCalendarAccounts.mockResolvedValue([{ ...configured, subcalendars: [{ calendarId: 'example-subcalendar', color: '#00ff00' }] }]);
  await act(async () => { handlers.forEach(fn => fn()); });
  expect(screen.getByRole('button', { name: /Configured meeting/ }).getAttribute('style')).not.toBe(originalStyle);
  api.getCalendarAccounts.mockResolvedValue([]);
  api.getCalendarEvents.mockResolvedValue({ events: [], total: 0 });
  await act(async () => { handlers.forEach(fn => fn()); });
  expect(screen.queryByRole('button', { name: /Configured meeting/ })).toBeNull();
  expect(screen.getByText('0 accounts')).toBeVisible();
});

it('moves the Week view current-time line each minute and clears the timer on unmount', async () => {
  api.getCalendarAccounts.mockResolvedValue([account]);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 7, 9));
  try {
    const { unmount } = renderCalendar('/calendar/week?week=2026-10-04');
    await act(async () => {});
    const currentTimeLine = screen.getByLabelText('Current time');
    expect(currentTimeLine).toHaveStyle({ top: '720px' });
    act(() => vi.advanceTimersByTime(60_000));
    expect(currentTimeLine).toHaveStyle({ top: '721.3333333333334px' });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
