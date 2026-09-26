import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { socket, api } = vi.hoisted(() => {
  const handlers = new Map();
  return {
    socket: {
      on: (event, fn) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); },
      off: (event, fn) => handlers.get(event)?.delete(fn),
      emit: vi.fn(),
      receive: (event, data = {}) => { for (const fn of handlers.get(event) || []) fn(data); },
    },
    api: Object.fromEntries(['getGoals', 'getCosUpcomingTasks', 'getBackupStatus', 'getBackupSnapshots', 'getCosQuickSummary', 'getCosLearningSummary', 'getCosRecentTasks', 'getCosActivityCalendar', 'getCosDecisionSummary', 'listThreads', 'getAutoFixMetrics', 'triggerBackup'].map(name => [name, vi.fn()])),
  };
});
vi.mock('../services/socket', () => ({ default: socket }));
vi.mock('../services/api', () => api);
vi.mock('./ui/Toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
import GoalProgressWidget from './GoalProgressWidget';
import UpcomingTasksWidget from './UpcomingTasksWidget';
import BackupWidget from './BackupWidget';
import CosDashboardWidget from './CosDashboardWidget';
import DecisionLogWidget from './DecisionLogWidget';
import OpenThreadsWidget from './dashboard/builtins/OpenThreadsWidget';
import AutoFixMetricsWidget from './dashboard/builtins/AutoFixMetricsWidget';

const flush = () => act(async () => {});
const visible = state => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
};
const cases = [
  { name: 'goals', Component: GoalProgressWidget, read: 'getGoals', event: 'goals:changed',
    data: title => ({ goals: [{ id: 'example', title, status: 'active', progress: 25 }] }) },
  { name: 'upcoming tasks', Component: UpcomingTasksWidget, read: 'getCosUpcomingTasks', event: 'cos:schedule:changed',
    data: description => [{ taskType: 'example', description, status: 'ready' }] },
  { name: 'backup status', Component: BackupWidget, read: 'getBackupStatus', event: 'backup:changed',
    data: error => ({ status: 'error', error, lastRun: new Date().toISOString() }) },
  { name: 'CoS summary', Component: CosDashboardWidget, read: 'getCosRecentTasks', event: 'cos:agent:completed',
    data: description => ({ tasks: [{ id: 'example', description, taskType: 'example', success: true, completedAt: new Date().toISOString() }], summary: { total: 1, succeeded: 1 } }),
    prepare: () => { fireEvent.click(screen.getByText('Recent Tasks')); } },
  { name: 'decision log', Component: DecisionLogWidget, read: 'getCosDecisionSummary', event: 'cos:decisions:changed',
    data: reason => ({ hasImpactfulDecisions: true, last24Hours: { total: 1, skipped: 1 }, impactfulDecisions: [{ id: 'example', type: 'task_skipped', reason, context: {}, timestamp: new Date().toISOString() }], transparencyScore: 100 }),
    prepare: () => { fireEvent.click(screen.getByText('Recent Decisions')); } },
  { name: 'open threads', Component: OpenThreadsWidget, read: 'listThreads', event: 'brain:threads:changed',
    data: title => ({ threads: [{ id: 'example', title, status: 'open' }], total: 1 }) },
  { name: 'auto-fix metrics', Component: AutoFixMetricsWidget, read: 'getAutoFixMetrics', event: 'cos:tasks:changed',
    data: label => ({ total: 1, overall: { resolved: 1, successRate: 1 }, byTier: [{ tier: 1, label, strategy: label, total: 1, resolved: 1, successRate: 1 }], trend: [] }) },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  visible('visible');
  api.getCosQuickSummary.mockResolvedValue({ today: { completed: 1 }, queue: {}, status: {} });
  api.getCosLearningSummary.mockResolvedValue({});
  api.getCosActivityCalendar.mockResolvedValue({ weeks: [], summary: {} });
  api.getBackupStatus.mockResolvedValue({ status: 'never' });
  api.getBackupSnapshots.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('dashboard resource subscriptions', () => {
  it.each(cases)('$name updates on events, never polls, and reconciles once per reconnect/reshow', async ({ Component, read, event, data, prepare }) => {
    api[read].mockResolvedValue(data('Example before'));
    render(<MemoryRouter><Component /></MemoryRouter>);
    await flush();
    prepare?.();
    expect(screen.getByText('Example before', { exact: false })).toBeInTheDocument();
    expect(api[read]).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(360_000); });
    expect(api[read]).toHaveBeenCalledTimes(1);
    api[read].mockResolvedValue(data('Example after'));
    await act(async () => socket.receive(event));
    expect(screen.getByText('Example after', { exact: false })).toBeInTheDocument();
    expect(api[read]).toHaveBeenCalledTimes(2);
    await act(async () => socket.receive('connect'));
    expect(api[read]).toHaveBeenCalledTimes(3);
    await act(async () => visible('hidden'));
    await act(async () => { socket.receive(event); socket.receive('connect'); });
    expect(api[read]).toHaveBeenCalledTimes(3);
    await act(async () => visible('visible'));
    expect(api[read]).toHaveBeenCalledTimes(4);
    await act(async () => visible('visible'));
    expect(api[read]).toHaveBeenCalledTimes(4);
  });

  it('refreshes the open snapshot list after backup finalization without a timer', async () => {
    api.getBackupSnapshots.mockResolvedValue([{ id: 'example-before', fileCount: 1 }]);
    render(<MemoryRouter><BackupWidget /></MemoryRouter>);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Snapshots' }));
    await flush();
    expect(screen.getByText('example-before')).toBeInTheDocument();
    api.getBackupSnapshots.mockResolvedValue([{ id: 'example-after', fileCount: 2 }]);
    await act(async () => socket.receive('backup:changed'));
    expect(screen.getByText('example-after')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(360_000); });
    expect(api.getBackupSnapshots).toHaveBeenCalledTimes(2);
    await act(async () => socket.receive('connect'));
    expect(api.getBackupSnapshots).toHaveBeenCalledTimes(3);
    await act(async () => visible('hidden'));
    await act(async () => visible('visible'));
    expect(api.getBackupSnapshots).toHaveBeenCalledTimes(4);
  });
});
