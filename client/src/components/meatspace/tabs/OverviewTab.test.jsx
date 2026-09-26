import { act, render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('../../../services/socket', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: new EventEmitter() };
});
vi.mock('../../../services/api', () => ({
  getMeatspaceOverview: vi.fn(), getAlcoholSummary: vi.fn(), getBodyHistory: vi.fn(),
  getBloodTests: vi.fn(), getEpigeneticTests: vi.fn(), getEyeExams: vi.fn(),
  getLatestHealthMetrics: vi.fn(), getLifeCalendar: vi.fn(),
}));
vi.mock('../../DeathClockCountdown', () => ({ default: () => null }));
import * as api from '../../../services/api';
import socket from '../../../services/socket';
import OverviewTab from './OverviewTab';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  api.getMeatspaceOverview.mockResolvedValue({ summary: { totalEntries: 7 } });
  api.getAlcoholSummary.mockResolvedValue({});
  api.getBodyHistory.mockResolvedValue([{ date: '2026-01-01', weightLbs: 170 }]);
  api.getBloodTests.mockResolvedValue({ tests: [] });
  api.getEpigeneticTests.mockResolvedValue({ tests: [] });
  api.getEyeExams.mockResolvedValue({ exams: [] });
  api.getLatestHealthMetrics.mockResolvedValue({});
  api.getLifeCalendar.mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('renders local and mirrored invalidations selectively, retaining good data on failed reads without polling', async () => {
  render(<MemoryRouter><OverviewTab /></MemoryRouter>);
  await act(async () => {});
  expect(screen.getByText('170 lbs')).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  for (const fn of Object.values(api)) expect(fn).toHaveBeenCalledTimes(1);

  api.getBodyHistory.mockResolvedValue([{ date: '2026-01-02', weightLbs: 172 }]);
  await act(async () => { socket.emit('meatspace:changed', { resources: ['body', 'overview'] }); });
  expect(screen.getByText('172 lbs')).toBeInTheDocument();
  expect(api.getAlcoholSummary).toHaveBeenCalledTimes(1);
  expect(api.getMeatspaceOverview).toHaveBeenCalledTimes(2);

  // MortalLoom and local writers share the same invalidation contract.
  api.getBloodTests.mockResolvedValue({ tests: [{ date: '2026-02-03' }] });
  await act(async () => { socket.emit('meatspace:changed', { resources: ['blood'] }); });
  expect(screen.getByText('2026-02-03')).toBeInTheDocument();
  api.getBodyHistory.mockRejectedValue(new Error('temporarily unavailable'));
  await act(async () => { socket.emit('meatspace:changed', { resources: ['body'] }); });
  expect(screen.getByText('172 lbs')).toBeInTheDocument();
});

it('reconciles each resource once on reconnect and once on tab re-show, then unsubscribes', async () => {
  const view = render(<MemoryRouter><OverviewTab /></MemoryRouter>);
  await act(async () => {});
  await act(async () => { socket.emit('connect'); });
  for (const fn of Object.values(api)) expect(fn).toHaveBeenCalledTimes(2);
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    socket.emit('meatspace:changed', { resources: ['body'] });
  });
  for (const fn of Object.values(api)) expect(fn).toHaveBeenCalledTimes(2);
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  for (const fn of Object.values(api)) expect(fn).toHaveBeenCalledTimes(3);
  view.unmount();
  expect(socket.listenerCount('meatspace:changed')).toBe(0);
});
