import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../services/apiVideoDownload.js', () => ({
  listVideoDownloads: vi.fn().mockResolvedValue([
    { id: 'a', filename: 'a.mp4', thumbnail: 'a.jpg', title: 'Clip A', createdAt: new Date().toISOString() },
    { id: 'b', filename: 'b.mp4', thumbnail: 'b.jpg', title: 'Clip B', createdAt: new Date().toISOString() },
  ]),
  deleteVideoDownload: vi.fn(),
}));
vi.mock('../hooks', () => ({
  useVideoDownload: () => ({ active: false, percent: 0, stage: '', start: vi.fn(), cancel: vi.fn() }),
  useConfirmDelete: () => ({ isConfirming: () => false, requestDelete: vi.fn(), cancelDelete: vi.fn(), confirmDelete: vi.fn() }),
}));
vi.mock('../components/video/YtDlpUpdateCard', () => ({ default: () => null }));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import VideoDownloaderPage from './VideoDownloaderPage';
import { listVideoDownloads } from '../services/apiVideoDownload.js';

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
});
