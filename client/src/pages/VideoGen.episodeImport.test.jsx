import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

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
const importError = () => screen.queryByText(/Could not load the FableLoom episode/);

describe('VideoGen Episode Composer FableLoom import', () => {
  beforeEach(() => {
    localStorage.clear();
    resetVideoGenMockState();
    state.renderDrawerContent = true;
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([]));
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([]));
  });

  it('reports a failed episode read and keeps it visible until a retry succeeds', async () => {
    state.getLoom.mockRejectedValueOnce(new Error('loom unavailable'));
    await renderVideoGenPage(IMPORT_ENTRY);

    expect(await screen.findByText(/Could not load the FableLoom episode — loom unavailable/)).toBeInTheDocument();
    expect(state.getLoom).toHaveBeenCalledWith('loom-1', { silent: true });

    let resolveRetry;
    state.getLoom.mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Retrying…' })).toBeDisabled();
    expect(importError()).toBeInTheDocument();

    await act(async () => { resolveRetry({ episodes: [{ id: 'ep-1', nodes: [] }] }); });
    await waitFor(() => expect(importError()).toBeNull());
    expect(screen.getByTestId('episode-composer')).toBeInTheDocument();
  });

  it('reports an episode missing from the loaded loom instead of opening it as empty', async () => {
    state.getLoom.mockResolvedValueOnce({ episodes: [{ id: 'ep-other', nodes: [] }] });
    await renderVideoGenPage(IMPORT_ENTRY);

    expect(await screen.findByText(/Could not load the FableLoom episode — it is no longer in this loom/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('does not keep the previous episode\'s scenes after switching to an episode with none', async () => {
    state.getLoom.mockResolvedValue({
      episodes: [
        { id: 'ep-1', nodes: [{ id: 'n1', title: 'Dock', prose: 'Rain on the pier.' }] },
        { id: 'ep-2', nodes: [] },
      ],
    });
    await renderVideoGenPage(IMPORT_ENTRY);
    expect(await screen.findByText('1 imported scenes')).toBeInTheDocument();

    await act(async () => { state.navigate('/media/video?episode=1&loomId=loom-1&episodeId=ep-2'); });
    await waitFor(() => expect(state.getLoom).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('0 imported scenes')).toBeInTheDocument();
  });

  it('does not carry a failed import into a plain composer opened after Back', async () => {
    state.getLoom.mockRejectedValueOnce(new Error('loom unavailable'));
    await renderVideoGenPage(IMPORT_ENTRY);
    expect(await screen.findByText(/Could not load the FableLoom episode/)).toBeInTheDocument();

    await act(async () => { state.navigate('/media/video'); });
    await act(async () => { state.navigate('/media/video?episode=1'); });
    expect(screen.getByTestId('episode-composer')).toBeInTheDocument();
    expect(importError()).toBeNull();
  });
});
