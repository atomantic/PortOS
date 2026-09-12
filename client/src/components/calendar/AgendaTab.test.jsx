import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { socketMock } = vi.hoisted(() => ({
  socketMock: { on: vi.fn(), off: vi.fn() },
}));

vi.mock('../../services/socket', () => ({ default: socketMock }));
vi.mock('../../services/api', () => ({
  getCalendarEvents: vi.fn(),
  syncCalendarAccount: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import * as api from '../../services/api';
import AgendaTab from './AgendaTab';

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <>
    <span data-testid="pathname">{location.pathname}</span>
    <span data-testid="query">{location.search}</span>
    <button onClick={() => navigate(-1)}>Back</button>
  </>;
}

async function renderAgenda(accounts, entry = '/calendar/agenda') {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="*"
          element={<><AgendaTab accounts={accounts} /><LocationProbe /></>}
        />
      </Routes>
    </MemoryRouter>
  );
  await act(async () => {});
}

describe('AgendaTab empty states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCalendarEvents.mockResolvedValue({ events: [] });
  });

  it('directs users without an enabled account to calendar sync', async () => {
    await renderAgenda([{ id: 'disabled', name: 'Personal', enabled: false }]);

    const connectLink = await screen.findByRole('link', { name: 'Connect a calendar' });
    expect(connectLink.getAttribute('href')).toBe('/calendar/sync');
    expect(screen.getByText('No calendar connected')).toBeTruthy();
    expect(screen.queryByText('Sync your calendar accounts to see events here')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sync' })).toBeDisabled();

    fireEvent.click(connectLink);
    expect(screen.getByTestId('pathname')).toHaveTextContent('/calendar/sync');
  });

  it('offers an enabled in-page sync action when accounts have no events', async () => {
    await renderAgenda([{ id: 'enabled', name: 'Personal', enabled: true }]);

    expect(await screen.findByText('Sync now to pull upcoming events')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sync now' })).not.toBeDisabled();
  });

  it('offers to clear active filters instead of suggesting a sync', async () => {
    await renderAgenda([{ id: 'enabled', name: 'Personal', enabled: true }]);

    fireEvent.change(await screen.findByRole('textbox', { name: 'Search events' }), {
      target: { value: 'missing' },
    });

    expect(await screen.findByText('No matching events')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear filters' })).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });
});

const accounts = [
  { id: 'personal', name: 'Personal', enabled: true },
  { id: 'work', name: 'Work', enabled: true },
];
const event = (id, startTime, endTime = startTime, extra = {}) => ({
  id, accountId: 'personal', title: `Event ${id}`, startTime, endTime, ...extra,
});

function serveEvents(records) {
  api.getCalendarEvents.mockImplementation(async ({ startDate, search, accountId, offset, limit }) => {
    const matching = records.filter(record => new Date(record.endTime) >= new Date(startDate)
      && (!search || record.title.includes(search))
      && (!accountId || record.accountId === accountId))
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    return { events: matching.slice(offset, offset + limit), total: matching.length };
  });
}

describe('AgendaTab date scope and paging', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('starts at local midnight, keeps overnight/all-day events, and browses history with URL Back and Today', async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const history = event('history', yesterday.toISOString());
    serveEvents([
      history,
      event('overnight', yesterday.toISOString(), new Date(today.getTime() + 3600000).toISOString()),
      event('all-day', today.toISOString(), tomorrow.toISOString(), { isAllDay: true }),
      event('future', tomorrow.toISOString()),
    ]);
    await renderAgenda(accounts);
    expect(api.getCalendarEvents).toHaveBeenLastCalledWith({ startDate: today.toISOString(), limit: 50, offset: 0 });
    expect(screen.queryByText(history.title)).toBeNull();
    expect(screen.getByText('Event overnight')).toBeTruthy();
    expect(screen.getByText('All day')).toBeTruthy();
    expect(screen.getByText('Event future')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2000-01-02' } });
    expect(await screen.findByText(history.title)).toBeTruthy();
    expect(screen.getByTestId('query')).toHaveTextContent('from=2000-01-02');
    expect(api.getCalendarEvents).toHaveBeenLastCalledWith({
      startDate: new Date(2000, 0, 2).toISOString(), limit: 50, offset: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await act(async () => {});
    expect(screen.queryByText(history.title)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText(history.title)).toBeTruthy();
    expect(screen.getByLabelText('From date')).toHaveValue('2000-01-02');
  });

  it('recovers history from the upcoming-empty state', async () => {
    serveEvents([event('history', '2000-01-02T12:00:00')]);
    await renderAgenda(accounts);
    expect(screen.getByText('No upcoming events')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2000-01-02' } });
    expect(await screen.findByText('Event history')).toBeTruthy();
  });

  it('reads the selected date from the URL without UTC day shifting and clears back to today', async () => {
    api.getCalendarEvents.mockResolvedValue({ events: [], total: 0 });
    await renderAgenda(accounts, '/calendar/agenda?from=2026-03-08');
    expect(screen.getByLabelText('From date')).toHaveValue('2026-03-08');
    expect(api.getCalendarEvents).toHaveBeenLastCalledWith({
      startDate: new Date(2026, 2, 8).toISOString(), limit: 50, offset: 0,
    });
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '' } });
    await act(async () => {});
    expect(screen.getByTestId('query')).not.toHaveTextContent('from=');
  });

  it('loads every page in order and resets on account, search, date, and completed sync', async () => {
    const records = Array.from({ length: 105 }, (_, i) => event(String(i).padStart(3, '0'),
      new Date(2099, 0, 1, 0, i).toISOString()));
    serveEvents(records);
    await renderAgenda(accounts);
    expect(screen.getByRole('status')).toHaveTextContent('50 of 105');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await act(async () => {});
    expect(screen.getByRole('status')).toHaveTextContent('100 of 105');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await act(async () => {});
    expect(screen.getByRole('status')).toHaveTextContent('105 of 105');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Event / }).map(button => button.textContent.slice(0, 9)))
      .toEqual(records.map(record => record.title));
    expect(api.getCalendarEvents.mock.calls.map(([params]) => params.offset)).toEqual([0, 50, 100]);

    fireEvent.change(screen.getByLabelText('Filter by account'), { target: { value: 'work' } });
    expect(await screen.findByText('No matching events')).toBeTruthy();
    expect(api.getCalendarEvents).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: 'work', offset: 0 }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Search events'), { target: { value: '104' } });
    expect(await screen.findByText('Event 104')).toBeTruthy();
    expect(screen.getByRole('status')).toHaveTextContent('1 of 1');
    expect(api.getCalendarEvents).toHaveBeenLastCalledWith(expect.objectContaining({ search: '104', offset: 0 }));

    fireEvent.change(screen.getByLabelText('Search events'), { target: { value: '' } });
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2099-01-01' } });
    await act(async () => {});
    expect(screen.getByRole('status')).toHaveTextContent('50 of 105');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await act(async () => {});
    const syncHandler = socketMock.on.mock.calls.filter(([name]) => name === 'calendar:sync:completed').at(-1)[1];
    await act(async () => syncHandler());
    expect(screen.getByRole('status')).toHaveTextContent('50 of 105');
    expect(api.getCalendarEvents).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }));
  });

  it('ignores a late previous-filter page and retries failed pages without losing loaded events', async () => {
    const first = event('first', '2099-01-01T12:00:00');
    api.getCalendarEvents.mockResolvedValue({ events: [first], total: 2 });
    await renderAgenda(accounts);
    let finishOldPage;
    api.getCalendarEvents.mockImplementationOnce(() => new Promise(resolve => { finishOldPage = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    api.getCalendarEvents.mockResolvedValue({ events: [event('new', '2099-01-02T12:00:00')], total: 2 });
    fireEvent.change(screen.getByLabelText('Search events'), { target: { value: 'new' } });
    await act(async () => {});
    await act(async () => finishOldPage({ events: [event('stale', '2099-01-01T13:00:00')], total: 2 }));
    expect(screen.queryByText('Event stale')).toBeNull();
    expect(screen.queryByText('Event first')).toBeNull();
    expect(screen.getByText('Event new')).toBeTruthy();

    api.getCalendarEvents.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load events');
    expect(screen.getByText('Event new')).toBeTruthy();
    api.getCalendarEvents.mockResolvedValueOnce({ events: [event('last', '2099-01-03T12:00:00')], total: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Event last')).toBeTruthy();
    expect(api.getCalendarEvents).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1 }));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});
