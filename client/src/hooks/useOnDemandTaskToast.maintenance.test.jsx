import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import MaintenanceRunStatus from '../components/cos/tabs/schedule/MaintenanceRunStatus';
import toast, { Toaster } from '../components/ui/Toast';

const handlers = vi.hoisted(() => new Map());
vi.mock('../services/socket', () => ({ default: {
  on: (event, handler) => handlers.set(event, handler),
  off: (event, handler) => { if (handlers.get(event) === handler) handlers.delete(event); },
  emit: () => {},
} }));

const { useOnDemandTaskToast } = await import('./useOnDemandTaskToast');
const run = {
  id: 'maintenance-example', status: 'running', completed: {}, reason: null,
  steps: [{ id: 'quality-step', taskRef: { taskType: 'security' } }],
  active: { stepId: 'quality-step', taskType: 'security', status: 'queued', requestId: 'request-example' },
};
function Subscriber() {
  useOnDemandTaskToast();
  return null;
}
function Harness({ subscribed = true }) {
  return <>{subscribed && <Subscriber />}<Toaster />
    <aside aria-label="Ongoing quality run"><MaintenanceRunStatus run={run} /></aside>
  </>;
}
const update = (changes = {}) => act(() => handlers.get('cos:maintenance:updated')?.({ ...run, ...changes }));
const advance = ms => act(() => vi.advanceTimersByTime(ms));
const notifications = () => within(screen.getByRole('region', { name: 'Notifications' }));

beforeEach(() => { vi.useFakeTimers(); handlers.clear(); });
afterEach(() => { cleanup(); toast.dismiss(); vi.useRealTimers(); });

describe('maintenance submission notification lifetime', () => {
  it('expires at five seconds despite ordinary queue/progress events and keeps the ongoing view accessible', () => {
    render(<Harness />);
    update();
    advance(1000);
    update({ reason: 'waiting for the CoS daemon to accept request request-example (security)' });
    advance(1000);
    update({ reason: 'waiting for request preparation request-example' });
    advance(1000);
    update({ active: { ...run.active, taskId: 'task-example', status: 'pending' }, reason: 'waiting for pending task task-example' });
    advance(1000);
    update({ active: { ...run.active, taskId: 'task-example', status: 'in_progress' }, reason: 'waiting for in progress task task-example' });
    advance(999);
    expect(notifications().getByRole('button', { name: 'Dismiss notification' })).toBeVisible();
    advance(1);
    expect(notifications().queryByRole('status')).toBeNull();
    expect(within(screen.getByRole('complementary', { name: 'Ongoing quality run' })).getByRole('status')).toHaveTextContent('running');
    update({ active: { ...run.active, status: 'running', agentId: 'agent-example' } });
    expect(notifications().queryByRole('status')).toBeNull();

    update({ id: 'maintenance-next' });
    advance(4999);
    expect(notifications().getByRole('button', { name: 'Dismiss notification' })).toBeVisible();
    advance(1);
    expect(notifications().queryByRole('status')).toBeNull();
  });

  it('respects manual dismissal without suppressing a new actionable hold', () => {
    render(<Harness />);
    update();
    fireEvent.click(notifications().getByRole('button', { name: 'Dismiss notification' }));
    update({ active: { ...run.active, status: 'running', agentId: 'agent-example' } });
    expect(notifications().queryByRole('status')).toBeNull();
    update({ reason: 'Provider setup requires attention' });
    advance(20000);
    fireEvent.click(notifications().getByRole('button', { name: /Show notification:/ }));
    expect(notifications().getByText('Provider setup requires attention')).toBeInTheDocument();
    fireEvent.click(notifications().getByRole('button', { name: 'Dismiss notification' }));
    update({ reason: 'Provider setup requires attention', active: { ...run.active, agentId: 'agent-example' } });
    expect(notifications().queryByRole('status')).toBeNull();
    update({ reason: 'Choose an available provider' });
    expect(notifications().getByText('Choose an available provider')).toBeInTheDocument();
    update();
    expect(notifications().queryByRole('status')).toBeNull();
  });

  it('keeps blocked tasks and stopped failures available instead of treating them as submission success', () => {
    render(<Harness />);
    update({ active: { ...run.active, taskId: 'task-example', status: 'blocked' }, reason: 'waiting for blocked task task-example' });
    advance(20000);
    fireEvent.click(notifications().getByRole('button', { name: /Show notification:/ }));
    expect(notifications().getByText('waiting for blocked task task-example')).toBeInTheDocument();
    update({ status: 'stopped', reason: 'Request was interrupted; resume explicitly.', updatedAt: 'finished' });
    advance(20000);
    fireEvent.click(notifications().getByRole('button', { name: /Show notification:/ }));
    expect(notifications().getByText('Request was interrupted; resume explicitly.')).toBeInTheDocument();
  });

  it('preserves the toast focus pause without restarting the remaining lifetime on progress', () => {
    render(<Harness />);
    update();
    advance(2000);
    const dismiss = notifications().getByRole('button', { name: 'Dismiss notification' });
    fireEvent.focus(dismiss);
    advance(10000);
    update({ active: { ...run.active, status: 'running' } });
    expect(dismiss).toBeVisible();
    fireEvent.blur(dismiss, { relatedTarget: document.body });
    advance(2999);
    expect(dismiss).toBeVisible();
    advance(1);
    expect(notifications().queryByRole('status')).toBeNull();
  });

  it('does not forget an active receipt or dismissed failure when settled history exceeds the cache limit', () => {
    render(<Harness />);
    update();
    advance(5000);
    const failure = { id: 'maintenance-held', status: 'stopped', reason: 'Request was interrupted; resume explicitly.', updatedAt: 'finished' };
    update(failure);
    fireEvent.click(notifications().getByRole('button', { name: 'Dismiss notification' }));
    for (let index = 0; index < 101; index++) {
      update({ id: `maintenance-settled-${index}`, status: 'completed', active: null, updatedAt: 'finished' });
    }
    advance(8000);
    update({ active: { ...run.active, status: 'running', agentId: 'agent-example' } });
    update({ ...failure, active: { ...run.active, agentId: 'agent-example' } });
    expect(notifications().queryByRole('status')).toBeNull();
    expect(notifications().queryByRole('button', { name: /Show notification:/ })).toBeNull();
  });

  it('removes only its own notices and timers when the subscriber unmounts', () => {
    const { rerender } = render(<Harness />);
    act(() => toast('Unrelated notice', { duration: 10000 }));
    const unrelatedTimers = vi.getTimerCount();
    update();
    expect(vi.getTimerCount()).toBeGreaterThan(unrelatedTimers);
    rerender(<Harness subscribed={false} />);
    expect(notifications().queryByRole('button', { name: 'Dismiss notification' })).toBeNull();
    expect(notifications().getByText('Unrelated notice')).toBeVisible();
    expect(vi.getTimerCount()).toBe(unrelatedTimers);
    expect(handlers.size).toBe(0);
    advance(10000);
    expect(notifications().queryByRole('status')).toBeNull();
  });

  it('still owns the completion notice when the oldest active run finishes after the history cache fills', () => {
    const { rerender } = render(<Harness />);
    update();
    advance(5000);
    for (let index = 0; index < 100; index++) {
      update({ id: `maintenance-settled-${index}`, status: 'completed', active: null, updatedAt: 'finished' });
    }
    advance(8000);
    update({ status: 'completed', active: null, completed: { 'quality-step': 'done' }, updatedAt: 'finished' });
    expect(notifications().getByRole('button', { name: 'Dismiss notification' })).toBeVisible();
    rerender(<Harness subscribed={false} />);
    expect(notifications().queryByRole('status')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
