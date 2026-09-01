import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const hookState = vi.hoisted(() => ({
  value: { status: 'queued', progress: 0, filename: null, error: null },
}));
vi.mock('../../hooks/useMediaJobProgress', () => ({ default: () => hookState.value }));
const apiMocks = vi.hoisted(() => ({ getLoomFalVideo: vi.fn() }));
vi.mock('../../services/api', () => ({
  getLoomFalVideo: (...args) => apiMocks.getLoomFalVideo(...args),
}));

import LoomMediaJobWatchers from './LoomMediaJobWatchers';

describe('LoomMediaJobWatchers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('polls a fal browser job and forwards its durable video history id once', async () => {
    const onUpdate = vi.fn();
    const onTerminal = vi.fn();
    apiMocks.getLoomFalVideo.mockResolvedValue({
      id: 'fal-job-1',
      source: 'fal-browser',
      loomId: 'loom-1',
      episodeId: 'ep-1',
      nodeId: 'node-1',
      status: 'completed',
      videoHistoryId: 'upload-ab12cd34',
    });

    const { rerender } = render(
      <LoomMediaJobWatchers
        jobs={{ 'node-1': { video: {
          jobId: 'fal-job-1', source: 'fal-browser', loomId: 'loom-1', episodeId: 'ep-1', status: 'queued',
        } } }}
        onUpdate={onUpdate}
        onTerminal={onTerminal}
      />,
    );

    await waitFor(() => expect(onTerminal).toHaveBeenCalledWith(
      'node-1',
      'video',
      'fal-job-1',
      expect.objectContaining({ status: 'completed', videoHistoryId: 'upload-ab12cd34' }),
    ));
    expect(apiMocks.getLoomFalVideo).toHaveBeenCalledWith(
      'loom-1', 'ep-1', 'node-1', 'fal-job-1', { silent: true },
    );

    rerender(
      <LoomMediaJobWatchers
        jobs={{ 'node-1': { video: {
          jobId: 'fal-job-1', source: 'fal-browser', loomId: 'loom-1', episodeId: 'ep-1', status: 'queued',
        } } }}
        onUpdate={onUpdate}
        onTerminal={onTerminal}
      />,
    );
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });
});
