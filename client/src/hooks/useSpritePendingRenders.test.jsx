import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';

// Regression coverage for the record-scoping the hook gained when it was
// lifted to the Sprites page (#2931). Before the lift the hook lived inside a
// per-record workflow and was destroyed on a record switch; now one instance
// serves every record, so it MUST drop the previous record's in-flight map on
// switch — otherwise character B inherits character A's "Rendering…" entries.

const listMediaJobs = vi.fn();
const getMediaJob = vi.fn();
const socket = vi.hoisted(() => {
  const handlers = new Map();
  return {
    on: (event, fn) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); },
    off: (event, fn) => handlers.get(event)?.delete(fn),
    receive: (event, payload) => handlers.get(event)?.forEach(fn => fn(payload)),
  };
});
vi.mock('../services/socket', () => ({ default: socket }));
vi.mock('../services/apiMediaJobs.js', () => ({
  listMediaJobs: (...args) => listMediaJobs(...args),
  getMediaJob: (...args) => getMediaJob(...args),
}));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import { useSpritePendingRenders } from './useSpritePendingRenders.js';

const opts = (recordId) => ({
  recordId, kind: 'video', tagKey: 'spriteWalk', tagField: 'direction', onChanged: vi.fn(),
});

beforeEach(() => {
  listMediaJobs.mockReset().mockResolvedValue([]);
  getMediaJob.mockReset().mockRejectedValue({ status: 503 });
});

afterEach(async () => { await act(async () => {}); cleanup(); vi.useRealTimers(); });

describe('useSpritePendingRenders record scoping', () => {
  it('reserves a key immediately and reports it as pending', async () => {
    const { result } = renderHook(() => useSpritePendingRenders(opts('char-a')));
    act(() => result.current.beginSubmit('east'));
    expect(result.current.pendingJobs.east).toBe('submitting');
    await act(async () => {});
  });

  it('clears the in-flight map when the record switches', async () => {
    const { result, rerender } = renderHook(
      ({ id }) => useSpritePendingRenders(opts(id)),
      { initialProps: { id: 'char-a' } },
    );
    act(() => { result.current.beginSubmit('east'); result.current.resolveSubmit('east', 'job-1'); });
    expect(result.current.pendingJobs.east).toBe('job-1');

    // Switching to character B must not carry A's "east is rendering" entry.
    rerender({ id: 'char-b' });
    await waitFor(() => expect(result.current.pendingJobs.east).toBeUndefined());
    expect(result.current.pendingJobs).toEqual({});
  });

  it('exposes stable setter identities so consumers can memoize on them', async () => {
    const { result, rerender } = renderHook(() => useSpritePendingRenders(opts('char-a')));
    const first = result.current;
    act(() => rerender());
    expect(result.current.beginSubmit).toBe(first.beginSubmit);
    expect(result.current.resolveSubmit).toBe(first.resolveSubmit);
    expect(result.current.cancelSubmit).toBe(first.cancelSubmit);
    await act(async () => {});
  });

  it('cancelSubmit only clears its own in-flight sentinel', async () => {
    const { result } = renderHook(() => useSpritePendingRenders(opts('char-a')));
    act(() => { result.current.beginSubmit('east'); result.current.resolveSubmit('west', 'job-9'); });
    act(() => result.current.cancelSubmit('east'));
    expect(result.current.pendingJobs.east).toBeUndefined();
    expect(result.current.pendingJobs.west).toBe('job-9'); // a resolved sibling job is untouched
    await act(async () => {});
  });
});

const job = (id, status, recordId = 'char-a') => ({
  id, status, error: status === 'failed' ? 'Render error' : null,
  params: { spriteWalk: { recordId, direction: 'east' } },
});
const changed = (recordId = 'char-a') => socket.receive('sprites:jobs-changed', {
  recordId, kind: 'video', tagKey: 'spriteWalk',
});
const PendingView = ({ id = 'char-a' }) => {
  const renders = useSpritePendingRenders(opts(id));
  return <>
    <span>{renders.pendingJobs.east || 'Ready'}</span>
    <button onClick={() => renders.beginSubmit('east')}>Submit</button>
    <button onClick={() => renders.resolveSubmit('east', 'job-fast')}>Resolve</button>
  </>;
};

describe('sprite queue event reconciliation', () => {
  it('renders terminal changes without timers and reconciles reconnect and tab show once', async () => {
    vi.useFakeTimers();
    listMediaJobs.mockResolvedValue([job('job-1', 'running')]);
    render(<PendingView />);
    await act(async () => {});
    expect(screen.getByText('job-1')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(listMediaJobs).toHaveBeenCalledTimes(1);
    await act(async () => changed('char-b'));
    expect(listMediaJobs).toHaveBeenCalledTimes(1);
    listMediaJobs.mockResolvedValue([job('job-1', 'canceled')]);
    await act(async () => changed());
    expect(screen.getByText('Ready')).toBeInTheDocument();
    const count = listMediaJobs.mock.calls.length;
    await act(async () => socket.receive('connect'));
    expect(listMediaJobs).toHaveBeenCalledTimes(count + 1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(listMediaJobs).toHaveBeenCalledTimes(count + 2);
  });

  it('keeps submitting reserved when terminal events beat HTTP and reports a failure once', async () => {
    const { default: toast } = await import('../components/ui/Toast');
    toast.error.mockClear();
    render(<PendingView />);
    await act(async () => {});
    fireEvent.click(screen.getByText('Submit'));
    listMediaJobs.mockResolvedValue([job('job-fast', 'failed')]);
    await act(async () => changed());
    expect(screen.getByText('submitting')).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByText('Resolve')));
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledTimes(1);
    await act(async () => changed());
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('preserves a missing job on transient failure and releases it only on 404', async () => {
    render(<PendingView />);
    await act(async () => fireEvent.click(screen.getByText('Resolve')));
    expect(screen.getByText('job-fast')).toBeInTheDocument();
    getMediaJob.mockRejectedValue({ status: 404 });
    await act(async () => socket.receive('connect'));
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('drops a late old-record reconciliation without clearing the new record', async () => {
    let finishOld;
    listMediaJobs.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const view = render(<PendingView />);
    await act(async () => {});
    listMediaJobs.mockResolvedValue([job('job-new', 'running', 'char-b')]);
    view.rerender(<PendingView id="char-b" />);
    await act(async () => {});
    expect(screen.getByText('job-new')).toBeInTheDocument();
    await act(async () => finishOld([job('job-old', 'failed')]));
    expect(screen.getByText('job-new')).toBeInTheDocument();
  });
});
