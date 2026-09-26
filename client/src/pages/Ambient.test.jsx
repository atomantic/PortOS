import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Ambient from './Ambient';
import * as api from '../services/api';
import socket from '../services/socket';
import { formatClockTime, formatDateFull } from '../utils/formatters';

vi.mock('../services/api', () => ({
  getDeathClock: vi.fn(), getCosQuickSummary: vi.fn(),
  getCosGoalProgressSummary: vi.fn(), getCalendarEvents: vi.fn(), checkHealth: vi.fn()
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
const reads = () => [api.getDeathClock, api.getCosQuickSummary, api.getCosGoalProgressSummary, api.getCalendarEvents].map(fn => fn.mock.calls.length);
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
  api.getDeathClock.mockResolvedValue({ deathDate: '2080-01-01', percentComplete: 25 });
  api.getCosQuickSummary.mockResolvedValue({ today: { running: 1 }, status: { running: true } });
  api.getCosGoalProgressSummary.mockResolvedValue({ goals: [{ name: 'Example goal', successRate: 50 }] });
  api.getCalendarEvents.mockResolvedValue({ events: [{ id: 'example', title: 'Example meeting',
    startTime: new Date(2026, 0, 15, 12).toISOString(), endTime: new Date(2026, 0, 15, 12, 1).toISOString() }], total: 1 });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Ambient resource updates', () => {
  it('renders each affected resource on its event without rereading unrelated resources', async () => {
    await mount();
    expect(reads()).toEqual([1, 1, 1, 1]);
    expect(screen.getByText('Example meeting')).toBeTruthy();
    api.getCalendarEvents.mockResolvedValue({ events: [{ id: 'new', title: 'Changed meeting', isAllDay: true, startTime: new Date(2026, 0, 15, 13).toISOString() }], total: 1 });
    await event('calendar:sync:completed');
    expect(screen.getByText('Changed meeting')).toBeTruthy();
    expect(screen.getByText('All day')).toBeTruthy();
    expect(reads()).toEqual([1, 1, 1, 2]);
    api.getDeathClock.mockResolvedValue({ deathDate: '2085-01-01', percentComplete: 20 });
    await event('meatspace:death-clock:changed');
    expect(screen.getByText('2085-01-01')).toBeTruthy();
    expect(reads()).toEqual([2, 1, 1, 2]);
    api.getCosQuickSummary.mockResolvedValue({ today: { running: 7 } });
    await event('cos:agent:spawned');
    expect(screen.getByText('7')).toBeTruthy();
    expect(reads()).toEqual([2, 2, 1, 2]);
    api.getCosGoalProgressSummary.mockResolvedValue({ goals: [{ name: 'Updated goal', successRate: 80 }] });
    await event('cos:goals:changed');
    expect(screen.getByText('Updated goal')).toBeTruthy();
    expect(reads()).toEqual([2, 2, 2, 2]);
    expect(socket.emit.mock.calls.filter(([name]) => name === 'cos:subscribe')).toHaveLength(1);
  });

  it('keeps the clock and upcoming events current past 30 seconds without polling', async () => {
    await mount();
    await flush(() => vi.advanceTimersByTime(61000));
    expect(reads()).toEqual([1, 1, 1, 1]);
    expect(api.checkHealth).not.toHaveBeenCalled();
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
    expect(api.getCalendarEvents).toHaveBeenLastCalledWith({
      startDate: new Date(2026, 0, 16).toISOString(),
      endDate: new Date(2026, 0, 17).toISOString(), limit: 200, offset: 0
    });
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

  it('reads all calendar pages and preserves the last snapshot when an event read fails', async () => {
    api.getCalendarEvents.mockResolvedValueOnce({ events: [{ id: 'past', title: 'Past', endTime: new Date(2026, 0, 15, 11).toISOString() }], total: 2 })
      .mockResolvedValueOnce({ events: [{ id: 'future', title: 'Later meeting', startTime: new Date(2026, 0, 15, 13).toISOString() }], total: 2 });
    await mount();
    expect(screen.getByText('Later meeting')).toBeTruthy();
    expect(api.getCalendarEvents.mock.calls[1][0].offset).toBe(1);
    api.getCalendarEvents.mockRejectedValueOnce(new Error('offline'));
    await event('calendar:sync:completed');
    expect(screen.getByText('Later meeting')).toBeTruthy();
  });
});
