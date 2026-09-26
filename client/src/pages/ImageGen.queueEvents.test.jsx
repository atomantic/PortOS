import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { loadImageGenPage, renderImageGenPage, resetImageGenMockState, state } from '../test/imageGenPageMocks.jsx';

const handlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
    },
    off: (event, handler) => handlers.get(event)?.delete(handler),
    emit: vi.fn(),
  },
}));
const emit = async (event) => act(async () => {
  for (const handler of handlers.get(event) || []) handler({});
});
await loadImageGenPage();

describe('Image Gen queue events', () => {
  beforeEach(() => {
    resetImageGenMockState();
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('applies enqueue acknowledgements without double-counting an earlier queue event', async () => {
    await renderImageGenPage();
    fireEvent.click(screen.getByRole('button', { name: /^generate$/i }));
    await act(async () => {});
    expect(screen.getByRole('button', { name: /^queue$/i })).toBeInTheDocument();
    let acknowledge;
    state.generateImage.mockReturnValueOnce(new Promise((resolve) => { acknowledge = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: /^queue$/i }));
    state.listMediaJobs.mockResolvedValue([
      { id: 'job-1', status: 'running' }, { id: 'job-2', status: 'queued' },
    ]);
    await emit('media-jobs:changed');
    expect(screen.getByText('+1 queued')).toBeInTheDocument();
    await act(async () => { acknowledge({ jobId: 'job-2', status: 'queued' }); });
    expect(screen.getByText('+1 queued')).toBeInTheDocument();
    expect(screen.queryByText('+2 queued')).not.toBeInTheDocument();

    // A subsequent acknowledgement must also update immediately without an event.
    state.generateImage.mockResolvedValueOnce({ jobId: 'job-3', status: 'queued' });
    fireEvent.click(screen.getByRole('button', { name: /^queue$/i }));
    await act(async () => {});
    expect(screen.getByText('+2 queued')).toBeInTheDocument();
  });

  it('updates queue counts from events and reconciles once on reconnect and tab show without polling', async () => {
    await renderImageGenPage();
    expect(state.listMediaJobs).toHaveBeenCalledTimes(1);
    state.listMediaJobs.mockResolvedValue([{ id: 'image-job', status: 'queued' }]);
    await emit('media-jobs:changed');
    expect(screen.getByText('+1 queued')).toBeInTheDocument();
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    expect(state.listMediaJobs).toHaveBeenCalledTimes(2);
    state.listMediaJobs.mockResolvedValue([]);
    await emit('connect');
    expect(state.listMediaJobs).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('+1 queued')).not.toBeInTheDocument();

    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    state.listMediaJobs.mockResolvedValue([{ id: 'new-image-job', status: 'running' }]);
    await emit('media-jobs:changed');
    expect(state.listMediaJobs).toHaveBeenCalledTimes(3);
    visibility.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(state.listMediaJobs).toHaveBeenCalledTimes(4);
    expect(screen.getByText('+1 queued')).toBeInTheDocument();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(state.listMediaJobs).toHaveBeenCalledTimes(4);
  });
});
