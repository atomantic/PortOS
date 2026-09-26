import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
const socket = vi.hoisted(() => {
  const handlers = new Map();
  return {
    handlers,
    emit: vi.fn(),
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
    },
    off: (event, handler) => handlers.get(event)?.delete(handler),
    fire: (event, data) => { for (const handler of handlers.get(event) || []) handler(data); },
  };
});
vi.mock('../../services/socket', () => ({ default: socket }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });


const api = vi.hoisted(() => ({
  getCosTasks: vi.fn(),
  forceSpawnTask: vi.fn(),
}));

vi.mock('../../services/api.js', () => api);
vi.mock('../media/MediaJobsQueue.jsx', () => ({
  default: () => <div>Media queue</div>,
}));

const QueuesPanel = (await import('./QueuesPanel.jsx')).default;

// The count cards render their label and value as sibling divs; read the value
// without pinning which wrapper element holds them.
const countCard = (label) => screen.getByText(label).nextElementSibling?.textContent;

const renderPanel = () => render(
  <MemoryRouter>
    <QueuesPanel />
  </MemoryRouter>,
);

describe('QueuesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an unknown state instead of a false empty queue after a failed probe', async () => {
    api.getCosTasks.mockRejectedValue(new Error('offline'));

    renderPanel();

    expect(await screen.findByText('Agent queue status is unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('No pending agent tasks.')).not.toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(4);
  });

  it('gives repeated task actions unique names and task-specific deep links', async () => {
    api.getCosTasks.mockResolvedValue({
      user: { tasks: [{ id: 'user/42', description: 'Run an example task', status: 'pending' }] },
      cos: { tasks: [{ id: 'review-7', description: 'Review an example task', status: 'pending', approvalRequired: true }] },
    });

    renderPanel();

    expect(await screen.findByRole('button', { name: 'Run task user/42 now' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review task review-7' })).toHaveAttribute(
      'href',
      '/cos/tasks?task=review-7&source=internal',
    );
  });

  // The spawn window: a task keeps `status: 'pending'` for a beat after its
  // agent registers as running, so the one task being worked was counted on BOTH
  // cards and still offered a "Run now" button for a run already underway. The
  // route settles it and stamps `spawning`; the panel must honour that rather
  // than re-reading the raw status.
  it('counts a task the server marked mid-spawn as running, not pending', async () => {
    api.getCosTasks.mockResolvedValue({
      user: { tasks: [{ id: 'user/42', description: 'Run an example task', status: 'pending', spawning: true }] },
      cos: { tasks: [] },
    });

    renderPanel();

    expect(await screen.findByText('No pending agent tasks.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run task user/42 now' })).not.toBeInTheDocument();
    expect(countCard('Agent pending')).toBe('0');
    expect(countCard('Agent running')).toBe('1');
  });
});

it('updates queues from task/agent events, coalesces reads and preserves stale data on failure', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const pending = { user: { tasks: [{ id: 'task-1', description: 'Example task', status: 'pending' }] }, cos: { tasks: [] } };
  api.getCosTasks.mockResolvedValue(pending);
  const view = renderPanel();
  await act(async () => {});
  expect(countCard('Agent pending')).toBe('1');
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(api.getCosTasks).toHaveBeenCalledTimes(1);

  let resolveRead;
  api.getCosTasks.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
  await act(async () => socket.fire('cos:tasks:user:added'));
  await act(async () => {
    socket.fire('cos:agent:spawned');
    socket.fire('cos:tasks:changed');
    socket.fire('cos:tasks:cos:changed');
  });
  expect(api.getCosTasks).toHaveBeenCalledTimes(2);
  api.getCosTasks.mockResolvedValue({ user: { tasks: [{ ...pending.user.tasks[0], spawning: true }] }, cos: { tasks: [] } });
  await act(async () => resolveRead(pending));
  expect(api.getCosTasks).toHaveBeenCalledTimes(3);
  expect(countCard('Agent running')).toBe('1');
  expect(countCard('Agent pending')).toBe('0');

  api.getCosTasks.mockRejectedValueOnce(new Error('offline'));
  await act(async () => socket.fire('cos:tasks:user:completed'));
  expect(countCard('Agent running')).toBe('1');
  await act(async () => socket.fire('connect'));
  expect(api.getCosTasks).toHaveBeenCalledTimes(5);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    socket.fire('cos:agent:completed');
  });
  expect(api.getCosTasks).toHaveBeenCalledTimes(5);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(api.getCosTasks).toHaveBeenCalledTimes(6);
  view.unmount();
  await act(async () => {
    socket.fire('connect');
    socket.fire('cos:tasks:changed');
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(api.getCosTasks).toHaveBeenCalledTimes(6);
});


it('survives StrictMode and drops an outstanding read and its queued refresh on unmount', async () => {
  let resolveRead;
  api.getCosTasks.mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
  const view = render(<StrictMode><MemoryRouter><QueuesPanel /></MemoryRouter></StrictMode>);
  await act(async () => {});
  expect(api.getCosTasks).toHaveBeenCalledTimes(1);
  await act(async () => socket.fire('cos:tasks:changed'));
  view.unmount();
  await act(async () => resolveRead({ user: { tasks: [] }, cos: { tasks: [] } }));
  expect(api.getCosTasks).toHaveBeenCalledTimes(1);
});

it('shows an acknowledged spawn immediately while reconciliation is pending', async () => {
  api.getCosTasks.mockResolvedValueOnce({
    user: { tasks: [{ id: 'task-now', description: 'Example task', status: 'pending' }] },
    cos: { tasks: [] },
  }).mockImplementation(() => new Promise(() => {}));
  api.forceSpawnTask.mockResolvedValue({ success: true, taskId: 'task-now' });
  renderPanel();
  await act(async () => {});
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run task task-now now' })));
  expect(countCard('Agent running')).toBe('1');
  expect(countCard('Agent pending')).toBe('0');
});
