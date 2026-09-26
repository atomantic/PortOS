import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

const hookState = vi.hoisted(() => ({
  value: { status: 'queued', progress: 0, filename: null, error: null },
}));
vi.mock('../../hooks/useMediaJobProgress', () => ({ default: () => hookState.value }));
const apiMocks = vi.hoisted(() => ({ getLoomFalVideo: vi.fn() }));
vi.mock('../../services/api', () => ({
  getLoomFalVideo: (...args) => apiMocks.getLoomFalVideo(...args),
}));

const socketMock = vi.hoisted(() => {
  const listeners = new Map();
  return {
    on: vi.fn((name, fn) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    }),
    off: vi.fn((name, fn) => listeners.get(name)?.delete(fn)),
    receive: (name, data) => listeners.get(name)?.forEach(fn => fn(data)),
  };
});
vi.mock('../../services/socket', () => ({ default: socketMock }));

const snapshot = (patch = {}) => ({
  id: 'fal-job-1', source: 'fal-browser', loomId: 'loom-1', episodeId: 'ep-1',
  nodeId: 'node-1', status: 'running', progress: 0.3, ...patch,
});
const propsFor = (jobId = 'fal-job-1') => ({
  jobs: { 'node-1': { video: {
    jobId, source: 'fal-browser', loomId: 'loom-1', episodeId: 'ep-1', status: 'queued',
  } } },
  onUpdate: vi.fn(),
  onTerminal: vi.fn(),
});
const push = async (data) => act(async () => socketMock.receive('fableloom:fal-video:changed', data));
const visibility = async (state) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

import LoomMediaJobWatchers from './LoomMediaJobWatchers';

describe('LoomMediaJobWatchers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getLoomFalVideo.mockReset().mockResolvedValue(snapshot());
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    hookState.value = { status: 'queued', progress: 0, filename: null, error: null };
  });

  it('forwards a failed terminal media job exactly once', async () => {
    const onUpdate = vi.fn();
    const onTerminal = vi.fn();
    const props = {
      jobs: { node1: { image: { jobId: 'image-1', status: 'queued' } } },
      onUpdate,
      onTerminal,
    };
    const { rerender } = render(<LoomMediaJobWatchers {...props} />);
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(
      'node1', 'image', 'image-1', expect.objectContaining({ status: 'queued' }),
    ));

    hookState.value = { status: 'failed', progress: 0, filename: null, error: 'Synthetic failure' };
    rerender(<LoomMediaJobWatchers {...props} />);
    await waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1));
    expect(onTerminal).toHaveBeenCalledWith(
      'node1', 'image', 'image-1', expect.objectContaining({ status: 'failed', error: 'Synthetic failure' }),
    );

    rerender(<LoomMediaJobWatchers {...props} />);
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it('streams progress to two tabs and forwards durable completion once without polling', async () => {
    vi.useFakeTimers();
    const first = propsFor();
    const second = propsFor();
    render(<><LoomMediaJobWatchers {...first} /><LoomMediaJobWatchers {...second} /></>);
    await act(async () => {});
    expect(apiMocks.getLoomFalVideo).toHaveBeenCalledTimes(2);
    await push(snapshot({ progress: 0.8, statusMsg: 'Downloading' }));
    for (const props of [first, second]) {
      expect(props.onUpdate).toHaveBeenLastCalledWith('node-1', 'video', 'fal-job-1',
        expect.objectContaining({ progress: 0.8, statusMsg: 'Downloading' }));
    }
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(apiMocks.getLoomFalVideo).toHaveBeenCalledTimes(2);
    const completed = snapshot({ status: 'completed', progress: 1, videoHistoryId: 'upload-ab12cd34' });
    await push(completed);
    await push(completed);
    await push(snapshot());
    for (const props of [first, second]) {
      expect(props.onTerminal).toHaveBeenCalledExactlyOnceWith('node-1', 'video', 'fal-job-1', completed);
      expect(props.onUpdate).toHaveBeenLastCalledWith('node-1', 'video', 'fal-job-1', completed);
    }
    await act(async () => socketMock.receive('connect'));
    expect(apiMocks.getLoomFalVideo).toHaveBeenCalledTimes(2);
  });

  it('hydrates an already completed job and does not reread for callback changes', async () => {
    apiMocks.getLoomFalVideo.mockResolvedValue(snapshot({ status: 'completed', videoHistoryId: 'upload-ab12cd34' }));
    const props = propsFor();
    const { rerender } = render(<LoomMediaJobWatchers {...props} />);
    await waitFor(() => expect(props.onTerminal).toHaveBeenCalledTimes(1));
    rerender(<LoomMediaJobWatchers {...props} onUpdate={vi.fn()} />);
    expect(apiMocks.getLoomFalVideo).toHaveBeenCalledExactlyOnceWith(
      'loom-1', 'ep-1', 'node-1', 'fal-job-1', { silent: true });
  });

  it('reports failure once and ignores other jobs or scenes', async () => {
    const props = propsFor();
    render(<LoomMediaJobWatchers {...props} />);
    await act(async () => {});
    props.onUpdate.mockClear();
    for (const patch of [{ id: 'old-job' }, { loomId: 'other' }, { episodeId: 'other' }, { nodeId: 'other' }]) {
      await push(snapshot({ ...patch, status: 'failed' }));
    }
    expect(props.onUpdate).not.toHaveBeenCalled();
    const failed = snapshot({ status: 'failed', error: 'Free allowance exhausted' });
    await push(failed);
    await push(failed);
    expect(props.onTerminal).toHaveBeenCalledExactlyOnceWith('node-1', 'video', 'fal-job-1', failed);
  });

  it('recovers on reconnect and tab reshow after a failed snapshot without inventing failure', async () => {
    apiMocks.getLoomFalVideo.mockRejectedValueOnce(new Error('offline'));
    const props = propsFor();
    render(<LoomMediaJobWatchers {...props} />);
    await act(async () => {});
    expect(props.onTerminal).not.toHaveBeenCalled();
    await act(async () => socketMock.receive('connect'));
    expect(apiMocks.getLoomFalVideo).toHaveBeenCalledTimes(2);
    await visibility('hidden');
    await act(async () => socketMock.receive('connect'));
    expect(apiMocks.getLoomFalVideo).toHaveBeenCalledTimes(2);
    apiMocks.getLoomFalVideo.mockResolvedValue(snapshot({ status: 'completed', videoHistoryId: 'upload-ab12cd34' }));
    await visibility('visible');
    await visibility('visible');
    expect(apiMocks.getLoomFalVideo).toHaveBeenCalledTimes(3);
    expect(props.onTerminal).toHaveBeenCalledTimes(1);
  });

  it('drops HTTP responses overtaken by events, newer reads, a new job or unmount', async () => {
    const pending = [];
    apiMocks.getLoomFalVideo.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const props = propsFor();
    const { rerender, unmount } = render(<LoomMediaJobWatchers {...props} />);
    await push(snapshot({ progress: 0.8 }));
    await act(async () => pending[0](snapshot({ progress: 0.1 })));
    expect(props.onUpdate).toHaveBeenLastCalledWith('node-1', 'video', 'fal-job-1',
      expect.objectContaining({ progress: 0.8 }));
    await act(async () => socketMock.receive('connect'));
    await visibility('hidden');
    await visibility('visible');
    await act(async () => pending[2](snapshot({ progress: 0.9 })));
    await act(async () => pending[1](snapshot({ progress: 0.2 })));
    expect(props.onUpdate).toHaveBeenLastCalledWith('node-1', 'video', 'fal-job-1',
      expect.objectContaining({ progress: 0.9 }));
    await act(async () => socketMock.receive('connect'));
    const next = propsFor('fal-job-2');
    rerender(<LoomMediaJobWatchers {...next} />);
    await act(async () => pending[3](snapshot({ status: 'completed' })));
    await push(snapshot({ status: 'completed' }));
    expect(props.onTerminal).not.toHaveBeenCalled();
    expect(next.onTerminal).not.toHaveBeenCalled();
    unmount();
    await act(async () => pending[4](snapshot({ id: 'fal-job-2', status: 'failed' })));
    await push(snapshot({ id: 'fal-job-2', status: 'failed' }));
    expect(next.onUpdate).not.toHaveBeenCalled();
  });
});
