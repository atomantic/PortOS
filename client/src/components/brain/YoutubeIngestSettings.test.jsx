import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getYoutubeIngestSettings: vi.fn(),
  getNotesVaults: vi.fn(),
  getYoutubeIngests: vi.fn(),
  deleteYoutubeIngest: vi.fn(),
  updateYoutubeIngestSettings: vi.fn(),
}));

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

import YoutubeIngestSettings from './YoutubeIngestSettings';

const SETTINGS = { obsidianVaultId: null, obsidianFolder: '', autoSync: false, taskPriority: 'MEDIUM' };

const ingest = (videoId, ingestedAt) => ({ videoId, ingestedAt, title: `Video ${videoId}`, url: `https://youtu.be/${videoId}` });

beforeEach(() => {
  vi.clearAllMocks();
  api.getYoutubeIngestSettings.mockResolvedValue(SETTINGS);
  api.getNotesVaults.mockResolvedValue({ vaults: [] });
});

describe('YoutubeIngestSettings ingest history pagination (#8267)', () => {
  it('requests the first page at 50 and renders it without a Load more affordance when nothing else remains', async () => {
    api.getYoutubeIngests.mockResolvedValue({ ingests: [ingest('v1', '2026-01-02T00:00:00.000Z')] });

    render(<YoutubeIngestSettings />);

    await waitFor(() => expect(screen.getByText('Video v1')).toBeInTheDocument());

    expect(api.getYoutubeIngests).toHaveBeenCalledWith(expect.objectContaining({ limit: 50, cursor: null }));
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('appends the next page and forwards the prior nextCursor when Load more is clicked', async () => {
    api.getYoutubeIngests
      .mockResolvedValueOnce({ ingests: [ingest('v1', '2026-01-02T00:00:00.000Z')], nextCursor: 'opaque-token' })
      .mockResolvedValueOnce({ ingests: [ingest('v2', '2026-01-01T00:00:00.000Z')], nextCursor: null });

    render(<YoutubeIngestSettings />);
    await waitFor(() => expect(screen.getByText('Video v1')).toBeInTheDocument());

    const loadMore = await screen.findByRole('button', { name: /load more/i });
    fireEvent.click(loadMore);

    await waitFor(() => expect(screen.getByText('Video v2')).toBeInTheDocument());
    expect(api.getYoutubeIngests).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 50, cursor: 'opaque-token' }));
    // Both pages stay visible — appended, not replaced.
    expect(screen.getByText('Video v1')).toBeInTheDocument();
  });

  it('removes a forgotten ingest from the loaded page without refetching', async () => {
    api.getYoutubeIngests.mockResolvedValue({ ingests: [ingest('v1', '2026-01-02T00:00:00.000Z')] });
    api.deleteYoutubeIngest.mockResolvedValue({ message: 'Ingest removed' });

    render(<YoutubeIngestSettings />);
    await waitFor(() => expect(screen.getByText('Video v1')).toBeInTheDocument());

    const forgetButton = screen.getByRole('button', { name: /forget ingest: video v1/i });
    fireEvent.click(forgetButton); // arm
    fireEvent.click(forgetButton); // confirm

    await waitFor(() => expect(screen.queryByText('Video v1')).not.toBeInTheDocument());
    expect(api.deleteYoutubeIngest).toHaveBeenCalledWith('v1', expect.objectContaining({ silent: true }));
    expect(api.getYoutubeIngests).toHaveBeenCalledTimes(1);
  });
});
