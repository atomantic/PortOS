import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import {
  loadVideoGenPage,
  renderVideoGenPage,
  resetVideoGenMockState,
  state,
  videoGenModelContext,
  videoGenStatus,
} from '../test/videoGenPageMocks.jsx';

await loadVideoGenPage();

const IMPORT_ENTRY = '/media/video?episode=1&loomId=loom-1&episodeId=ep-1';

describe('VideoGen Episode Composer FableLoom import', () => {
  beforeEach(() => {
    localStorage.clear();
    resetVideoGenMockState();
    state.renderDrawerContent = true;
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([]));
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([]));
  });

  it('reports a failed episode read with Retry instead of opening a silently blank composer', async () => {
    state.getLoom.mockRejectedValueOnce(new Error('loom unavailable'));
    await renderVideoGenPage(IMPORT_ENTRY);

    const alert = await screen.findByText(/Could not load the FableLoom episode — loom unavailable/);
    expect(alert).toBeInTheDocument();
    expect(state.getLoom).toHaveBeenCalledWith('loom-1', { silent: true });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(state.getLoom).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Could not load the FableLoom episode/)).toBeNull());
    expect(screen.getByTestId('episode-composer')).toBeInTheDocument();
  });
});
