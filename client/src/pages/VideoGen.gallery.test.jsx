import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import {
  loadVideoGenPage, renderVideoGenPage, resetVideoGenMockState, state,
  videoGenModel, videoGenModelContext, videoGenStatus,
} from '../test/videoGenPageMocks.jsx';

// Exercise the page's real gallery, card, and delete confirmation together.
vi.doUnmock('../components/videoGen/VideoGenGallery');
vi.doMock('../components/media/AddToCollectionMenu', () => ({ default: () => null }));
vi.doMock('../components/media/PinToMoodBoardMenu', () => ({ default: () => null }));
await loadVideoGenPage();
const api = await import('../services/api');
const { default: toast } = await import('../components/ui/Toast');

const model = videoGenModel('example-video');
const record = { id: 'video-example', filename: 'example.mp4', prompt: 'A paper boat on a canal', modelId: model.id };

describe('VideoGen gallery deletion', () => {
  beforeEach(() => {
    resetVideoGenMockState();
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([model]));
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([model]));
    state.listVideoHistory.mockResolvedValue([record]);
    api.deleteVideoHistoryItem.mockReset();
    toast.error.mockClear();
  });

  it('keeps a failed deletion visible and removes it only after a successful retry', async () => {
    api.deleteVideoHistoryItem.mockRejectedValueOnce(new Error('Video could not be deleted'));
    await renderVideoGenPage();
    await screen.findByRole('button', { name: record.prompt });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })); });

    expect(toast.error).toHaveBeenCalledWith('Video could not be deleted');
    expect(screen.getByRole('button', { name: record.prompt })).toBeInTheDocument();
    expect(screen.getByText('Recent renders (1 of 1)')).toBeInTheDocument();

    api.deleteVideoHistoryItem.mockResolvedValueOnce({});
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })); });

    await waitFor(() => expect(screen.queryByRole('button', { name: record.prompt })).not.toBeInTheDocument());
    expect(api.deleteVideoHistoryItem).toHaveBeenLastCalledWith(record.id, { silent: true });
  });
});
