import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  getLifeCalendar: vi.fn(), removeActivity: vi.fn(), addActivity: vi.fn(),
  addLifeEvent: vi.fn(), updateLifeEvent: vi.fn(), removeLifeEvent: vi.fn(),
}));
// Chart-like panels need layout and are not part of the delete path.
vi.mock('./calendar/LifeGrid', () => ({ default: () => null }));
vi.mock('./calendar/TimeStats', () => ({ default: () => null }));
vi.mock('./calendar/LifeEventsPanel', () => ({ default: () => null }));
vi.mock('./calendar/AddActivityForm', () => ({ default: () => null }));

import * as api from '../../../services/api';
import CalendarTab from './CalendarTab';

const renderTab = () => render(<MemoryRouter><CalendarTab /></MemoryRouter>);

const CALENDAR = {
  birthDate: '1990-01-01',
  deathDate: '2070-01-01',
  stats: {
    age: { years: 36, weeks: 1870, days: 13000 },
    remaining: { years: 34, months: 400, weeks: 1800, days: 12000 },
    total: { weeks: 4000 },
  },
  total: { weeks: 4000 },
  grid: [],
  events: [],
  budgets: [
    { name: 'Coffees', cadence: 'day', frequency: 2, icon: 'coffee', remaining: 60000 },
    { name: 'Showers', cadence: 'day', frequency: 1, icon: 'droplets', remaining: 30000 },
    { name: 'Books', cadence: 'month', frequency: 1, icon: 'book-open', remaining: 400 },
  ],
};

const removeButtons = () => screen.getAllByRole('button', { name: 'Remove activity' });

beforeEach(() => {
  api.getLifeCalendar.mockResolvedValue(structuredClone(CALENDAR));
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('CalendarTab activity removal', () => {
  it('sends the row name, ignores a second click while in flight, and drops only that row locally', async () => {
    let resolveRemoval;
    api.removeActivity.mockReturnValue(new Promise(resolve => { resolveRemoval = resolve; }));
    await act(async () => { renderTab(); });
    await screen.findByText('Showers');

    // Two clicks before React re-renders, as a fast double-click produces.
    const trash = removeButtons()[1];
    fireEvent.click(trash);
    fireEvent.click(trash);
    expect(api.removeActivity).toHaveBeenCalledTimes(1);
    expect(api.removeActivity).toHaveBeenCalledWith(1, 'Showers', { silent: true });
    expect(removeButtons()[1].disabled).toBe(true);
    expect(removeButtons()[0].disabled).toBe(false);

    await act(async () => {
      resolveRemoval([CALENDAR.budgets[0], CALENDAR.budgets[2]].map(b => ({ name: b.name })));
    });
    expect(screen.queryByText('Showers')).toBeNull();
    expect(screen.getByText('Coffees')).toBeInTheDocument();
    expect(screen.getByText('Books')).toBeInTheDocument();
    expect(api.getLifeCalendar).toHaveBeenCalledTimes(1);
  });

  it('keeps the in-flight row disabled after an earlier row is removed above it', async () => {
    let resolveShowers;
    api.removeActivity
      .mockReturnValueOnce(new Promise(resolve => { resolveShowers = resolve; }))
      .mockResolvedValueOnce([{ name: 'Showers' }, { name: 'Books' }]);
    await act(async () => { renderTab(); });
    await screen.findByText('Showers');

    await act(async () => { fireEvent.click(removeButtons()[1]); });
    await act(async () => { fireEvent.click(removeButtons()[0]); });
    // Showers moved up to index 0 when Coffees was removed; it must still be the disabled row.
    expect(removeButtons()[0].disabled).toBe(true);
    expect(removeButtons()[1].disabled).toBe(false);
    await act(async () => { resolveShowers([{ name: 'Books' }]); });
  });

  it('refetches the list when the server reports the row moved, instead of deleting the wrong activity', async () => {
    api.removeActivity.mockRejectedValue(Object.assign(new Error('moved'), { code: 'ACTIVITY_MOVED' }));
    await act(async () => { renderTab(); });
    await screen.findByText('Books');

    await act(async () => { fireEvent.click(removeButtons()[2]); });
    await screen.findByText('Books');
    expect(api.getLifeCalendar).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Coffees')).toBeInTheDocument();
  });

  it('does not resurrect a row when a refetch started before a later delete resolves with the older list', async () => {
    let resolveStaleRead;
    let resolveFreshRead;
    api.getLifeCalendar
      .mockResolvedValueOnce(structuredClone(CALENDAR))
      .mockReturnValueOnce(new Promise(resolve => { resolveStaleRead = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveFreshRead = resolve; }));
    api.removeActivity
      .mockRejectedValueOnce(Object.assign(new Error('moved'), { code: 'ACTIVITY_MOVED' }))
      .mockResolvedValueOnce([{ name: 'Coffees' }, { name: 'Books' }]);
    await act(async () => { renderTab(); });
    await screen.findByText('Books');

    await act(async () => { fireEvent.click(removeButtons()[2]); });
    await act(async () => { fireEvent.click(removeButtons()[1]); });
    expect(screen.queryByText('Showers')).toBeNull();

    // The read that the 409 started finally lands with the pre-delete snapshot.
    await act(async () => { resolveStaleRead(structuredClone(CALENDAR)); });
    expect(screen.queryByText('Showers')).toBeNull();
    expect(screen.getByText('Books')).toBeInTheDocument();

    // The delete landed while that read was pending, so a fresh read follows and is what the list ends on.
    expect(api.getLifeCalendar).toHaveBeenCalledTimes(3);
    await act(async () => { resolveFreshRead({ ...structuredClone(CALENDAR), budgets: [CALENDAR.budgets[0], CALENDAR.budgets[2]] }); });
    expect(screen.queryByText('Showers')).toBeNull();
    expect(screen.getByText('Coffees')).toBeInTheDocument();
  });
});
