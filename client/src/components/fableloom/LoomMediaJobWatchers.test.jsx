import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const hookState = vi.hoisted(() => ({
  value: { status: 'queued', progress: 0, filename: null, error: null },
}));
vi.mock('../../hooks/useMediaJobProgress', () => ({ default: () => hookState.value }));

import LoomMediaJobWatchers from './LoomMediaJobWatchers';

describe('LoomMediaJobWatchers', () => {
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
});
