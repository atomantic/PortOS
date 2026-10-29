import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

vi.mock('../services/apiVideoDownload.js', () => ({
  listVideoDownloads: vi.fn().mockResolvedValue([
    { id: 'a', filename: 'a.mp4', thumbnail: 'a.jpg', title: 'Clip A', createdAt: new Date().toISOString() },
    { id: 'b', filename: 'b.mp4', thumbnail: 'b.jpg', title: 'Clip B', createdAt: new Date().toISOString() },
  ]),
  deleteVideoDownload: vi.fn(),
}));
vi.mock('../hooks/useVideoDownload.js', () => ({
  default: () => ({ active: false, percent: 0, stage: '', start: vi.fn(), cancel: vi.fn() }),
}));
const confirmState = vi.hoisted(() => ({ confirming: false }));
vi.mock('../hooks/useConfirmDelete.js', () => ({
  default: () => ({
    isConfirming: () => confirmState.confirming, requestDelete: vi.fn(), cancelDelete: vi.fn(), confirmDelete: (fn) => fn(),
  }),
}));
vi.mock('../components/video/YtDlpUpdateCard', () => ({ default: () => null }));
vi.mock('../components/ui/Toast', () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

import VideoDownloaderPage from './VideoDownloaderPage';
import { listVideoDownloads, deleteVideoDownload } from '../services/apiVideoDownload.js';
import toast from '../components/ui/Toast';

describe('VideoDownloaderPage', () => {
  it('swaps only the failed thumbnail for the placeholder', async () => {
    listVideoDownloads.mockResolvedValueOnce([
      { id: 'a', filename: 'a.mp4', thumbnail: 'a.jpg', title: 'Clip A', createdAt: new Date().toISOString() },
      { id: 'b', filename: 'b.mp4', thumbnail: 'b.jpg', title: 'Clip B', createdAt: new Date().toISOString() },
    ]);
    const { container } = render(<VideoDownloaderPage />);
    await waitFor(() => expect(container.querySelectorAll('img').length).toBe(2));
    const rows = screen.getAllByRole('listitem');
    const rowA = within(rows[0]);
    const imgA = rows[0].querySelector('img');
    expect(rows[0].querySelector('svg.lucide-video')).toBeNull();
    fireEvent.error(imgA);
    expect(rows[0].querySelector('img')).toBeNull();
    expect(rows[0].querySelector('svg.lucide-video')).not.toBeNull();
    expect(rows[1].querySelector('img')).not.toBeNull();
    expect(rowA.getByText('Clip A')).toBeTruthy();
  });

  it('renders ListLoadError with retry on failed downloads load, and empty copy on real empty list', async () => {
    listVideoDownloads.mockRejectedValueOnce(new Error('Downloads 500 error'));
    render(<VideoDownloaderPage />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load downloads — Downloads 500 error');
    expect(screen.getByRole('heading', { level: 1, name: 'Video Downloader' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('No videos downloaded yet.')).not.toBeInTheDocument();

    listVideoDownloads.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.getByText('No videos downloaded yet.')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  describe('delete', () => {
    beforeEach(() => { confirmState.confirming = true; });
    afterEach(() => { confirmState.confirming = false; });
    const confirmDeleteOf = async (title) => {
      const group = await screen.findByRole('group', { name: `Delete ${title}` });
      // The delete settles on promises; resolve them inside act.
      await act(async () => { fireEvent.click(within(group).getByRole('button', { name: 'Delete' })); });
    };

    it('removes a download deleted on this machine', async () => {
      deleteVideoDownload.mockResolvedValueOnce({ ok: true, status: 'deleted' });
      render(<VideoDownloaderPage />);
      await confirmDeleteOf('Clip A');
      await waitFor(() => expect(screen.queryByText('Clip A')).toBeNull());
      expect(screen.getByText('Clip B')).toBeInTheDocument();
    });

    // Uniquely catches the page dropping a peer's download whose delete is
    // still waiting on its owner.
    it('keeps a download whose delete is pending on its owner and says so', async () => {
      deleteVideoDownload.mockResolvedValueOnce({ ok: true, status: 'pending', pendingDelete: { peerId: 'rec-peer', queuedAt: '2026-01-02T00:00:00.000Z' }, peerName: 'Example Peer' });
      render(<VideoDownloaderPage />);
      await confirmDeleteOf('Clip A');
      await waitFor(() => expect(toast).toHaveBeenCalledWith('Delete pending until Example Peer is reachable'));
      expect(screen.getByText('Clip A')).toBeInTheDocument();
    });
  });
});
