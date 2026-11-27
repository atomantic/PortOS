import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/apiMeatspace.js', () => ({
  getLifeCalendar: vi.fn(),
  removeActivity: vi.fn(),
  addActivity: vi.fn(),
  addLifeEvent: vi.fn(),
  updateLifeEvent: vi.fn(),
  removeLifeEvent: vi.fn(),
}));
// Chart-like panels need layout and are not part of the delete path.
vi.mock('./calendar/LifeGrid', () => ({ default: () => null }));
vi.mock('./calendar/TimeStats', () => ({ default: () => null }));
vi.mock('./calendar/AddActivityForm', () => ({ default: () => null }));

import { getLifeCalendar, removeActivity, removeLifeEvent } from '../../../services/apiMeatspace.js';
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
    { id: 'a-coffees', name: 'Coffees', cadence: 'day', frequency: 2, icon: 'coffee', remaining: 60000 },
    { id: 'a-showers', name: 'Showers', cadence: 'day', frequency: 1, icon: 'droplets', remaining: 30000 },
    { id: 'a-books', name: 'Books', cadence: 'month', frequency: 1, icon: 'book-open', remaining: 400 },
  ],
};

const removeButtons = () => screen.getAllByRole('button', { name: 'Remove activity' });
const confirmRemoval = () => screen.getByRole('button', { name: 'Remove' });

async function removeActivityAt(index) {
  fireEvent.click(removeButtons()[index]);
  await act(async () => { fireEvent.click(confirmRemoval()); });
}

beforeEach(() => {
  getLifeCalendar.mockResolvedValue(structuredClone(CALENDAR));
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('announces life progress and the Life Events disclosure state', async () => {
  renderTab();
  const progress = await screen.findByRole('progressbar', { name: 'Life progress' });
  expect(progress).toHaveAttribute('aria-valuenow', '46.75');
  expect(progress).toHaveAttribute('aria-valuemin', '0');
  expect(progress).toHaveAttribute('aria-valuemax', '100');

  const disclosure = screen.getByRole('button', { name: /Life Events/i });
  expect(disclosure).toHaveAttribute('type', 'button');
  expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: 'Add Event' })).not.toBeInTheDocument();
  fireEvent.click(disclosure);
  expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: 'Add Event' })).toBeInTheDocument();
  fireEvent.click(disclosure);
  expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: 'Add Event' })).not.toBeInTheDocument();
});

describe('CalendarTab activity removal', () => {
  it('sends the row id, ignores a second click while in flight, and drops only that row locally', async () => {
    let resolveRemoval;
    removeActivity.mockReturnValue(new Promise(resolve => { resolveRemoval = resolve; }));
    await act(async () => { renderTab(); });
    await screen.findByText('Showers');

    const trash = removeButtons()[1];
    fireEvent.click(trash);
    expect(removeActivity).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(removeActivity).not.toHaveBeenCalled();
    fireEvent.click(removeButtons()[1]);
    const confirm = confirmRemoval();
    fireEvent.click(confirm);
    // A repeated activation of the old confirmation must not send another request.
    fireEvent.click(confirm);
    expect(removeActivity).toHaveBeenCalledTimes(1);
    expect(removeActivity).toHaveBeenCalledWith(1, { id: 'a-showers' }, { silent: true });
    expect(removeButtons()[1].disabled).toBe(true);
    expect(removeButtons()[0].disabled).toBe(false);

    await act(async () => {
      resolveRemoval([CALENDAR.budgets[0], CALENDAR.budgets[2]].map(b => ({ name: b.name })));
    });
    expect(screen.queryByText('Showers')).toBeNull();
    expect(screen.getByText('Coffees')).toBeInTheDocument();
    expect(screen.getByText('Books')).toBeInTheDocument();
    expect(getLifeCalendar).toHaveBeenCalledTimes(1);
  });

  it('keeps the in-flight row disabled after an earlier row is removed above it', async () => {
    let resolveShowers;
    removeActivity
      .mockReturnValueOnce(new Promise(resolve => { resolveShowers = resolve; }))
      .mockResolvedValueOnce([{ name: 'Showers' }, { name: 'Books' }]);
    await act(async () => { renderTab(); });
    await screen.findByText('Showers');

    await removeActivityAt(1);
    await removeActivityAt(0);
    // Showers moved up to index 0 when Coffees was removed; it must still be the disabled row.
    expect(removeButtons()[0].disabled).toBe(true);
    expect(removeButtons()[1].disabled).toBe(false);
    await act(async () => { resolveShowers([{ name: 'Books' }]); });
  });

  it('refetches the list when the server reports the row moved, instead of deleting the wrong activity', async () => {
    removeActivity.mockRejectedValue(Object.assign(new Error('moved'), { code: 'ACTIVITY_MOVED' }));
    await act(async () => { renderTab(); });
    await screen.findByText('Books');

    await removeActivityAt(2);
    await screen.findByText('Books');
    expect(getLifeCalendar).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Coffees')).toBeInTheDocument();
  });

  it('does not resurrect a row when a refetch started before a later delete resolves with the older list', async () => {
    let resolveStaleRead;
    let resolveFreshRead;
    getLifeCalendar
      .mockResolvedValueOnce(structuredClone(CALENDAR))
      .mockReturnValueOnce(new Promise(resolve => { resolveStaleRead = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveFreshRead = resolve; }));
    removeActivity
      .mockRejectedValueOnce(Object.assign(new Error('moved'), { code: 'ACTIVITY_MOVED' }))
      .mockResolvedValueOnce([{ name: 'Coffees' }, { name: 'Books' }]);
    await act(async () => { renderTab(); });
    await screen.findByText('Books');

    await removeActivityAt(2);
    await removeActivityAt(1);
    expect(screen.queryByText('Showers')).toBeNull();

    // The read that the 409 started finally lands with the pre-delete snapshot.
    await act(async () => { resolveStaleRead(structuredClone(CALENDAR)); });
    expect(screen.queryByText('Showers')).toBeNull();
    expect(screen.getByText('Books')).toBeInTheDocument();

    // The delete landed while that read was pending, so a fresh read follows and is what the list ends on.
    expect(getLifeCalendar).toHaveBeenCalledTimes(3);
    await act(async () => { resolveFreshRead({ ...structuredClone(CALENDAR), budgets: [CALENDAR.budgets[0], CALENDAR.budgets[2]] }); });
    expect(screen.queryByText('Showers')).toBeNull();
    expect(screen.getByText('Coffees')).toBeInTheDocument();
  });

  it('removes only the clicked one of two same-named activities, and disables only it', async () => {
    let resolveRemoval;
    getLifeCalendar.mockResolvedValue({
      ...structuredClone(CALENDAR),
      budgets: [
        { id: 'w1', name: 'Walks', cadence: 'day', frequency: 1, icon: 'circle', remaining: 100 },
        { id: 'w2', name: 'Walks', cadence: 'week', frequency: 3, icon: 'circle', remaining: 50 },
      ],
    });
    removeActivity.mockReturnValue(new Promise(resolve => { resolveRemoval = resolve; }));
    await act(async () => { renderTab(); });
    await screen.findAllByText('Walks');

    await removeActivityAt(1);
    expect(removeActivity).toHaveBeenCalledWith(1, { id: 'w2' }, { silent: true });
    expect(removeButtons().map(b => b.disabled)).toEqual([false, true]);

    await act(async () => { resolveRemoval([{ id: 'w1', name: 'Walks' }]); });
    expect(screen.getAllByText('Walks')).toHaveLength(1);
    expect(screen.getByText('1/day')).toBeInTheDocument();
  });

  it('falls back to the row name for a row stored before activity ids', async () => {
    getLifeCalendar.mockResolvedValue({
      ...structuredClone(CALENDAR),
      budgets: CALENDAR.budgets.map(({ id: _id, ...rest }) => rest),
    });
    removeActivity.mockResolvedValue([{ name: 'Coffees' }, { name: 'Books' }]);
    await act(async () => { renderTab(); });
    await screen.findByText('Showers');

    await removeActivityAt(1);
    expect(removeActivity).toHaveBeenCalledWith(1, { name: 'Showers' }, { silent: true });
    expect(screen.queryByText('Showers')).toBeNull();
  });
});

it('removes the selected life event only after confirmation', async () => {
  getLifeCalendar.mockResolvedValueOnce({
    ...structuredClone(CALENDAR),
    events: [{ id: 'event-1', name: 'Example event', enabled: true, type: 'holiday', recurrence: 'once', date: '2030-01-01' }],
  });
  removeLifeEvent.mockResolvedValue({ success: true });
  renderTab();

  fireEvent.click(await screen.findByRole('button', { name: /Life Events/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove Example event' }));
  expect(removeLifeEvent).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(confirmRemoval()); });
  expect(removeLifeEvent).toHaveBeenCalledExactlyOnceWith('event-1');
});
