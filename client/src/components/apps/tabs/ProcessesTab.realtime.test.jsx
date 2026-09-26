import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const handlers = new Map();
vi.mock('../../../services/socket', () => ({ default: {
  emit: vi.fn(),
  on: (event, fn) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); },
  off: (event, fn) => handlers.get(event)?.delete(fn),
} }));
vi.mock('../../../services/api', () => ({ getProcessesList: vi.fn(), applyProcessAction: vi.fn() }));
vi.mock('../../../hooks/useProcessLogs', () => ({ useProcessLogs: () => ({ logs: [], subscribed: false }) }));
import * as api from '../../../services/api';
import ProcessesTab from './ProcessesTab';
const emit = (event, data) => act(async () => { for (const fn of handlers.get(event) ?? []) fn(data); });
const process = { name: 'example-api', status: 'online', pm_id: 1 };
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); handlers.clear(); api.getProcessesList.mockResolvedValue([process]); });
afterEach(() => vi.useRealTimers());

it('renders pushed process state, ignores unrelated homes, and recovers without polling', async () => {
  const view = render(<ProcessesTab appId="app-a" />);
  await act(async () => {});
  expect(screen.getByText('online')).toBeInTheDocument();
  expect(api.getProcessesList).toHaveBeenCalledWith({ appId: 'app-a', silent: true });
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(api.getProcessesList).toHaveBeenCalledTimes(1);
  await emit('processes:changed', { appIds: ['app-b'], processes: [] });
  expect(screen.getByText('online')).toBeInTheDocument();
  await emit('processes:changed', { appIds: ['app-a'], processes: [{ ...process, status: 'stopped' }] });
  expect(screen.getByText('stopped')).toBeInTheDocument();
  await emit('processes:changed', { appIds: ['app-a'], processes: null });
  expect(screen.getByText('stopped')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('unavailable');
  await emit('connect');
  expect(api.getProcessesList).toHaveBeenCalledTimes(2);
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(api.getProcessesList).toHaveBeenCalledTimes(3);
  view.unmount();
  expect(handlers.get('processes:changed').size).toBe(0);
  await emit('connect');
  expect(api.getProcessesList).toHaveBeenCalledTimes(3);
});

it('does not overwrite a pushed snapshot or a new app with an older HTTP response', async () => {
  let finish;
  api.getProcessesList.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const view = render(<ProcessesTab appId="app-a" />);
  await emit('processes:changed', { appIds: ['app-a'], processes: [{ ...process, status: 'stopped' }] });
  await act(async () => finish([process]));
  expect(screen.getByText('stopped')).toBeInTheDocument();
  api.getProcessesList.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await emit('connect');
  view.rerender(<ProcessesTab appId="app-b" />);
  await act(async () => {});
  await act(async () => finish([]));
  expect(screen.getByText('online')).toBeInTheDocument();
});


it('applies a scoped command response immediately without a delayed refetch', async () => {
  api.applyProcessAction.mockResolvedValue({ processes: [{ ...process, status: 'stopped' }] });
  render(<ProcessesTab appId="app-a" />);
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop' })));
  expect(api.applyProcessAction).toHaveBeenCalledWith('example-api', 'stop', 'app-a');
  expect(screen.getByText('stopped')).toBeInTheDocument();
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(api.getProcessesList).toHaveBeenCalledTimes(1);
});
