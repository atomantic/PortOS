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

describe('VideoDownloaderPage thumbnails', () => {
  it('swaps only the failed thumbnail for the placeholder', async () => {
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
});
