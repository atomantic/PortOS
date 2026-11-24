import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Ambient from './Ambient';
import { allDayCalendarDate } from '../components/calendar/calendarUtils';
import { getDeathClock } from '../services/apiMeatspace.js';
import { getCosQuickSummary, getCosGoalProgressSummary } from '../services/apiAgents.js';
import { getCalendarEvents } from '../services/apiCalendar.js';
import { checkHealth } from '../services/apiSystem.js';
import socket from '../services/socket';
import { formatClockTime, formatDateFull } from '../utils/formatters';

vi.mock('../services/apiMeatspace.js', () => ({
  getDeathClock: vi.fn(),
}));
vi.mock('../services/apiAgents.js', () => ({
  getCosQuickSummary: vi.fn(),
  getCosGoalProgressSummary: vi.fn(),
}));
vi.mock('../services/apiCalendar.js', () => ({
  getCalendarEvents: vi.fn(),
}));
vi.mock('../services/apiSystem.js', () => ({
  checkHealth: vi.fn(),
}));
vi.mock('../services/socket', () => {
  const handlers = new Map();
  return { default: {
    connected: true, emit: vi.fn(),
    on: (event, fn) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); },
    off: (event, fn) => handlers.get(event)?.delete(fn),
    dispatch: (event, payload) => { for (const fn of handlers.get(event) || []) fn(payload); }
  } };
});
vi.mock('../components/DeathClockCountdown', () => ({ default: ({ deathDate }) => <div>{deathDate}</div> }));
const reads = () => [getDeathClock, getCosQuickSummary, getCosGoalProgressSummary, getCalendarEvents].map(fn => fn.mock.calls.length);
const flush = async (fn = () => {}) => act(async () => { fn(); });
const mount = () => flush(() => render(<MemoryRouter><Ambient /></MemoryRouter>));
const event = (name) => flush(() => socket.dispatch(name));
const visibility = (state) => flush(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.clearAllMocks();
  socket.connected = true;
  getDeathClock.mockResolvedValue({ deathDate: '2080-01-01', percentComplete: 25 });
  getCosQuickSummary.mockResolvedValue({ today: { running: 1 }, status: { running: true } });
  getCosGoalProgressSummary.mockResolvedValue({ goals: [{ name: 'Example goal', successRate: 50 }] });
  getCalendarEvents.mockResolvedValue({ events: [{ id: 'example', title: 'Example meeting',
    startTime: new Date(2026, 0, 15, 12).toISOString(), endTime: new Date(2026, 0, 15, 12, 1).toISOString() }], total: 1 });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Ambient resource updates', () => {
  it('renders each affected resource on its event without rereading unrelated resources', async () => {
    await mount();
    expect(reads()).toEqual([1, 1, 1, 1]);
    expect(screen.getByText('Example meeting')).toBeTruthy();
    getCalendarEvents.mockResolvedValue({ events: [{ id: 'new', title: 'Changed meeting', isAllDay: true, startTime: new Date(2026, 0, 15, 13).toISOString() }], total: 1 });
    await event('calendar:sync:completed');
    expect(screen.getByText('Changed meeting')).toBeTruthy();
    expect(screen.getByText('All day')).toBeTruthy();
    expect(reads()).toEqual([1, 1, 1, 2]);
    getDeathClock.mockResolvedValue({ deathDate: '2085-01-01', percentComplete: 20 });
    await event('meatspace:death-clock:changed');
    expect(screen.getByText('2085-01-01')).toBeTruthy();
    expect(reads()).toEqual([2, 1, 1, 2]);
    getCosQuickSummary.mockResolvedValue({ today: { running: 7 } });
    await event('cos:agent:spawned');
    expect(screen.getByText('7')).toBeTruthy();
    expect(reads()).toEqual([2, 2, 1, 2]);
    getCosGoalProgressSummary.mockResolvedValue({ goals: [{ name: 'Updated goal', successRate: 80 }] });
    await event('cos:goals:changed');
    expect(screen.getByText('Updated goal')).toBeTruthy();
    expect(reads()).toEqual([2, 2, 2, 2]);
    expect(socket.emit.mock.calls.filter(([name]) => name === 'cos:subscribe')).toHaveLength(1);
  });

  it('keeps the clock and upcoming events current past 30 seconds without polling', async () => {
    await mount();
    await flush(() => vi.advanceTimersByTime(61000));
    expect(reads()).toEqual([1, 1, 1, 1]);
    expect(checkHealth).not.toHaveBeenCalled();
    expect(screen.queryByText('Example meeting')).toBeNull();
    expect(screen.getByText(formatClockTime(new Date()))).toBeTruthy();
  });

  it('reconciles exactly once on reconnect and tab re-show, and uses socket connectivity', async () => {
    await mount();
    socket.connected = false;
    await event('disconnect');
    expect(screen.getByText('Connecting...')).toBeTruthy();
    expect(reads()).toEqual([1, 1, 1, 1]);
    socket.connected = true;
    await event('connect');
    expect(reads()).toEqual([2, 2, 2, 2]);
    expect(screen.getByText('System Online')).toBeTruthy();
    await visibility('hidden');
    await event('calendar:sync:completed');
    expect(reads()).toEqual([2, 2, 2, 2]);
    await visibility('visible');
    expect(reads()).toEqual([3, 3, 3, 3]);
    await visibility('visible');
    expect(reads()).toEqual([3, 3, 3, 3]);
  });

  it('reconciles date-bound resources at midnight with the new local date range', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 23, 59, 59));
    await mount();
    await flush(() => vi.advanceTimersByTime(2000));
    expect(reads()).toEqual([2, 2, 1, 2]);
    expect(getCalendarEvents).toHaveBeenLastCalledWith({
      startDate: new Date(2026, 0, 16).toISOString(),
      endDate: new Date(new Date(2026, 0, 17).getTime() - 1).toISOString(), limit: 200, offset: 0
    }, { silent: true });
    expect(screen.getByText(formatDateFull(new Date()))).toBeTruthy();
  });

  it('reconciles once when a suspended tab returns on a new day before its next clock tick', async () => {
    await mount();
    await visibility('hidden');
    vi.setSystemTime(new Date(2026, 0, 16, 8));
    await visibility('visible');
    await flush(() => vi.advanceTimersByTime(1000));
    expect(reads()).toEqual([2, 2, 2, 2]);
    expect(screen.getByText(formatDateFull(new Date()))).toBeTruthy();
  });

  it('keeps a Z-stamped all-day event until the local calendar date ends', async () => {
    expect(allDayCalendarDate('2026-07-05T00:00:00.000Z').getTime()).toBe(new Date(2026, 6, 5).getTime());
    const localEnd = new Date(2026, 6, 5).getTime();
    const absoluteEnd = Date.parse('2026-07-05T00:00:00.000Z');
    // West of UTC the absolute midnight is already past during the local evening.
    // East of UTC it is still ahead after local midnight. Either gap is the bug.
    const showAt = localEnd > absoluteEnd ? absoluteEnd + 1000 : localEnd - 60_000;
    vi.setSystemTime(new Date(showAt));
    getCalendarEvents.mockResolvedValue({
      events: [{
        id: 'jul4', title: 'July 4', isAllDay: true,
        startTime: '2026-07-04T00:00:00.000Z', endTime: '2026-07-05T00:00:00.000Z',
      }],
      total: 1,
    });
    await mount();
    expect(screen.getByText('July 4')).toBeTruthy();
    vi.setSystemTime(new Date(localEnd + 1000));
    await flush(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByText('July 4')).toBeNull();
  });

  it('reads all calendar pages and preserves the last snapshot when an event read fails', async () => {
    getCalendarEvents.mockResolvedValueOnce({ events: [{ id: 'past', title: 'Past', endTime: new Date(2026, 0, 15, 11).toISOString() }], total: 2 })
      .mockResolvedValueOnce({ events: [{ id: 'future', title: 'Later meeting', startTime: new Date(2026, 0, 15, 13).toISOString() }], total: 2 });
    await mount();
    expect(screen.getByText('Later meeting')).toBeTruthy();
    expect(getCalendarEvents.mock.calls[1][0].offset).toBe(1);
    getCalendarEvents.mockRejectedValueOnce(new Error('offline'));
    await event('calendar:sync:completed');
    expect(screen.getByText('Later meeting')).toBeTruthy();
  });
});

describe('Ambient idle controls', () => {
  const header = () => screen.getByRole('button', { name: /exit$/i }).parentElement;

  it('re-shows the hidden controls on keyboard activity and keeps a focused control visible', async () => {
    await mount();
    await flush(() => vi.advanceTimersByTime(3100));
    expect(header().className).toContain('opacity-0');
    // A focused control is never invisible: the wrapper carries the focus-within override.
    expect(header().className).toContain('focus-within:opacity-100');
    await flush(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })));
    expect(header().className).not.toMatch(/(^|\s)opacity-0/);
    await flush(() => vi.advanceTimersByTime(3100));
    expect(header().className).toContain('opacity-0');
    await flush(() => screen.getByRole('button', { name: /exit$/i }).focus());
    expect(header().className).not.toMatch(/(^|\s)opacity-0/);
  });
});


it('invalidates pending calendar reads, preserves stale content on failure, and retries', async () => {
  await mount();
  let resolveOld;
  let rejectCurrent;
  getCalendarEvents.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCurrent = reject; }));
  await event('calendar:changed');
  await event('calendar:changed');
  await flush(() => resolveOld({ events: [{ id: 'obsolete', title: 'Obsolete event', startTime: new Date(2026, 0, 15, 13).toISOString() }], total: 1 }));
  expect(screen.queryByText('Obsolete event')).toBeNull();
  expect(screen.getByText('Example meeting')).toBeTruthy();
  await flush(() => rejectCurrent(new Error('Read unavailable')));
  expect(screen.getByRole('alert')).toHaveTextContent('stale');
  getCalendarEvents.mockResolvedValue({ events: [], total: 0 });
  await flush(() => fireEvent.click(screen.getByRole('button', { name: 'Retry calendar' })));
  expect(screen.queryByText('Example meeting')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(reads()).toEqual([1, 1, 1, 4]);
});

describe('Ambient accessibility', () => {
  it('exposes landmarks, one h1, h2 panel headings, status role and pressed fullscreen state', async () => {
    await mount();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('PortOS Ambient');
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['Today', 'Goals', 'Agent Activity']);
    expect(screen.getByRole('status')).toHaveTextContent('System Online');
    const fs = screen.getByRole('button', { name: 'Fullscreen' });
    expect(fs).toHaveAttribute('aria-pressed', 'false');
    // always-dark keeps day themes from remapping the white-on-black text.
    expect(screen.getByRole('main').parentElement.className).toContain('always-dark');
  });

  it('does not leak a rejected fullscreen request', async () => {
    await mount();
    const original = document.documentElement.requestFullscreen;
    document.documentElement.requestFullscreen = vi.fn(() => Promise.reject(new Error('denied')));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await flush(() => fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' })));
      await flush(() => vi.advanceTimersByTime(10));
      expect(document.documentElement.requestFullscreen).toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      document.documentElement.requestFullscreen = original;
    }
  });

  it('only a bare Escape leaves the page', async () => {
    const { Routes, Route } = await import('react-router');
    await flush(() => render(<MemoryRouter initialEntries={['/ambient']}><Routes>
      <Route path="/ambient" element={<Ambient />} /><Route path="/" element={<div>Home page</div>} />
    </Routes></MemoryRouter>));
    const press = (init) => flush(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, ...init })));
    try {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.body });
      await press();
      expect(screen.queryByText('Home page')).toBeNull();
    } finally {
      delete document.fullscreenElement;
    }
    await flush(() => window.addEventListener('keydown', (e) => e.preventDefault(), { once: true, capture: true }));
    await press();
    expect(screen.queryByText('Home page')).toBeNull();
    await press();
    expect(screen.getByText('Home page')).toBeTruthy();
  });
});

it('shows errors and unknown counts until goal and agent reads succeed on Retry', async () => {
  getCosGoalProgressSummary.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ goals: [] });
  getCosQuickSummary.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ today: { running: 7, completed: 2, failed: 1 } });
  getCalendarEvents.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ events: [], total: 0 });
  await mount();

  const goals = within(screen.getByRole('heading', { name: 'Goals' }).parentElement.parentElement);
  const activity = within(screen.getByRole('heading', { name: 'Agent Activity' }).parentElement.parentElement);
  const calendar = within(screen.getByRole('heading', { name: 'Today' }).parentElement.parentElement);
  expect(goals.getByRole('alert')).toHaveTextContent('Could not load goals');
  expect(goals.queryByText('No active goals')).not.toBeInTheDocument();
  expect(activity.getByRole('alert')).toHaveTextContent('Could not load agent activity');
  expect(activity.getAllByText('—')).toHaveLength(3);
  expect(calendar.getByRole('alert')).toHaveTextContent('Calendar unavailable');
  expect(calendar.queryByText('No upcoming events')).not.toBeInTheDocument();

  await flush(() => fireEvent.click(goals.getByRole('button', { name: 'Retry' })));
  await flush(() => fireEvent.click(activity.getByRole('button', { name: 'Retry' })));
  await flush(() => fireEvent.click(calendar.getByRole('button', { name: 'Retry calendar' })));
  expect(goals.getByText('No active goals')).toBeInTheDocument();
  expect(activity.getByText('7')).toBeInTheDocument();
  expect(calendar.getByText('No upcoming events')).toBeInTheDocument();
});
