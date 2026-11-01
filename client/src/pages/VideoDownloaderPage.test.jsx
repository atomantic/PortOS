import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

vi.mock('../services/apiVideoDownload.js', () => ({
  listVideoDownloads: vi.fn().mockResolvedValue([
    { id: 'a', filename: 'a.mp4', thumbnail: 'a.jpg', title: 'Clip A', createdAt: new Date().toISOString() },
    { id: 'b', filename: 'b.mp4', thumbnail: 'b.jpg', title: 'Clip B', createdAt: new Date().toISOString() },
  ]),
  deleteVideoDownload: vi.fn(),
}));
vi.mock('../services/apiImageVideo.js', () => ({ cancelVideoPendingDelete: vi.fn().mockResolvedValue({}) }));
vi.mock('../services/api', () => ({
  getInstances: vi.fn().mockResolvedValue({ peers: [{ id: 'rec-peer', name: 'Example Peer' }] }),
}));
const download = vi.hoisted(() => ({ onComplete: null }));
vi.mock('../hooks/useVideoDownload.js', () => ({
  default: ({ onComplete }) => {
    download.onComplete = onComplete;
    return { active: false, percent: 0, stage: '', start: vi.fn(), cancel: vi.fn() };
  },
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
import { cancelVideoPendingDelete } from '../services/apiImageVideo.js';

describe('VideoDownloaderPage', () => {
  // Uniquely catches a pre-download list overwriting the completed clip.
  it.each([false, true])('reconciles a download during loading, with reconciliation failure=%s', async (fails) => {
    let resolveOld;
    let resolveFresh;
    const clip = { id: 'new', filename: 'new.mp4', title: 'New clip' };
    listVideoDownloads.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    if (fails) listVideoDownloads.mockRejectedValueOnce(new Error('Reconciliation offline'));
    else listVideoDownloads.mockImplementationOnce(() => new Promise((resolve) => { resolveFresh = resolve; }));
    render(<VideoDownloaderPage />);
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    act(() => download.onComplete(clip));
    if (fails) {
      expect(await screen.findByRole('alert')).toHaveTextContent('Reconciliation offline');
      expect(screen.queryByText('No videos downloaded yet.')).not.toBeInTheDocument();
      listVideoDownloads.mockResolvedValueOnce([clip]);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    } else {
      await waitFor(() => expect(resolveFresh).toBeTypeOf('function'));
      await act(async () => resolveFresh([clip]));
    }
    expect(await screen.findByText('New clip')).toBeInTheDocument();
    await act(async () => resolveOld([]));
    expect(screen.getByText('New clip')).toBeInTheDocument();
  });

  it('prepends a completed download immediately when the list is ready', async () => {
    const reads = listVideoDownloads.mock.calls.length;
    render(<VideoDownloaderPage />);
    await screen.findByText('Clip A');
    act(() => download.onComplete({ id: 'new', filename: 'new.mp4', title: 'New clip' }));
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('New clip');
    expect(listVideoDownloads).toHaveBeenCalledTimes(reads + 1);
  });

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

  // Uniquely catches a downloader row that cannot show or withdraw its pending delete.
  it('shows a loaded pending delete with the peer name and cancels it through the API', async () => {
    listVideoDownloads.mockResolvedValueOnce([
      { id: 'a', filename: 'a.mp4', title: 'Clip A', createdAt: new Date().toISOString(), pendingDelete: { peerId: 'rec-peer' } },
    ]);
    render(<VideoDownloaderPage />);
    expect(await screen.findByText('Delete pending on Example Peer')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel pending delete' })); });
    expect(cancelVideoPendingDelete).toHaveBeenCalledWith('a', { silent: true });
    await waitFor(() => expect(screen.queryByText(/Delete pending on/)).toBeNull());
    expect(screen.getByText('Clip A')).toBeInTheDocument();
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
