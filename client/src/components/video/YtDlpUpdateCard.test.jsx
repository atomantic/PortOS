import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import YtDlpUpdateCard from './YtDlpUpdateCard';

vi.mock('../../services/apiVideoDownload.js', () => ({
  getYtDlpStatus: vi.fn(),
  updateYtDlp: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const handlers = new Map();
vi.mock('../../hooks', () => ({
  useSocket: () => ({
    on: (event, fn) => handlers.set(event, fn),
    off: (event) => handlers.delete(event),
  }),
}));

import { getYtDlpStatus, updateYtDlp } from '../../services/apiVideoDownload.js';
import toast from '../ui/Toast';

const STALE = {
  installed: true, version: '2026.07.04', latestVersion: '2026.08.19',
  updateAvailable: true, canUpdate: true, method: 'brew', methodLabel: 'Homebrew',
  blockedReason: null, downloadUrl: 'https://example.com/install',
};

describe('YtDlpUpdateCard', () => {
  beforeEach(() => { vi.clearAllMocks(); handlers.clear(); });

  it('names the installed and available versions when yt-dlp is stale', async () => {
    getYtDlpStatus.mockResolvedValue(STALE);
    render(<YtDlpUpdateCard />);
    expect(await screen.findByText(/yt-dlp 2026\.07\.04 — 2026\.08\.19 is available/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /update yt-dlp/i })).toBeInTheDocument();
  });

  it('updates on click and re-reads the status so the card shows what landed', async () => {
    getYtDlpStatus
      .mockResolvedValueOnce(STALE)
      .mockResolvedValue({ ...STALE, version: '2026.08.19', updateAvailable: false });
    updateYtDlp.mockResolvedValue({ success: true, version: '2026.08.19' });

    render(<YtDlpUpdateCard />);
    await userEvent.click(await screen.findByRole('button', { name: /update yt-dlp/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(await screen.findByText(/Up to date via Homebrew/)).toBeInTheDocument();
  });

  it('reports a failed update instead of leaving the card claiming success', async () => {
    getYtDlpStatus.mockResolvedValue(STALE);
    updateYtDlp.mockRejectedValue(new Error('yt-dlp is pinned in Homebrew.'));

    render(<YtDlpUpdateCard />);
    await userEvent.click(await screen.findByRole('button', { name: /update yt-dlp/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('yt-dlp is pinned in Homebrew.'));
    expect(screen.getByRole('button', { name: /update yt-dlp/i })).toBeEnabled();
  });

  // A blocked install (pinned formula, unlinked keg) must not offer a button
  // that cannot work — the reason replaces it.
  it('shows the blocking reason and no update button when PortOS may not update', async () => {
    getYtDlpStatus.mockResolvedValue({ ...STALE, canUpdate: false, blockedReason: 'yt-dlp is pinned in Homebrew.' });
    render(<YtDlpUpdateCard />);
    expect(await screen.findByText('yt-dlp is pinned in Homebrew.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /update yt-dlp/i })).not.toBeInTheDocument();
  });

  it('points at install instructions when yt-dlp is missing entirely', async () => {
    getYtDlpStatus.mockResolvedValue({
      installed: false, version: null, canUpdate: false,
      blockedReason: 'yt-dlp is not on PATH.', downloadUrl: 'https://example.com/install',
    });
    render(<YtDlpUpdateCard />);
    expect(await screen.findByText(/yt-dlp is not installed/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /install instructions/i })).toHaveAttribute('href', 'https://example.com/install');
  });

  it('renders nothing while the status is unknown rather than claiming yt-dlp is missing', async () => {
    getYtDlpStatus.mockRejectedValue(new Error('offline'));
    const { container } = render(<YtDlpUpdateCard />);
    await waitFor(() => expect(getYtDlpStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
