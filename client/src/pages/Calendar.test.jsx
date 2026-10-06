import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import Calendar, { TABS } from './Calendar';

const api = vi.hoisted(() => ({
  getCalendarAccounts: vi.fn(),
  getCalendarEvents: vi.fn(),
  getCalendarTokenStatus: vi.fn(),
  getGoogleAuthStatus: vi.fn(),
  getDailyReview: vi.fn(),
  getChronotypeEnergySchedule: vi.fn(),
  syncCalendarAccount: vi.fn(),
}));
vi.mock('../services/api', () => api);
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
  api.getDailyReview.mockResolvedValue({ events: [], summary: { totalEvents: 0, confirmed: 0, skipped: 0, unreviewed: 0 } });
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
      expect(await screen.findByText('No calendar connected')).toBeVisible();
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

    expect(screen.getByText('Lifetime content')).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent('Calendar accounts unavailable');
    selectTab('Config');
    expect(screen.queryByText('No calendar accounts configured')).toBeNull();
    selectTab('Lifetime');
    expect(screen.getByText('Lifetime content')).toBeVisible();
  });

  it('treats an invalid account response as unavailable rather than empty', async () => {
    api.getCalendarAccounts.mockResolvedValue(null);
    renderCalendar();

    expect(await screen.findByRole('alert')).toHaveTextContent('Calendar accounts unavailable');
    expect(screen.queryByText('0 accounts')).toBeNull();
    expect(screen.queryByText('No calendar accounts configured')).toBeNull();
  });

  it('ignores a superseded mount read failure after the current snapshot succeeds', async () => {
    let rejectFirst;
    api.getCalendarAccounts.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce([account]);
    renderCalendar('/calendar/config', true);

    expect(await screen.findByText(account.name)).toBeVisible();
    await act(async () => rejectFirst(new Error('Superseded read')));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('1 account')).toBeVisible();
  });
});
