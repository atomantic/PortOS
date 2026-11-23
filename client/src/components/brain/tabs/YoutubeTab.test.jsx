import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getYoutubeStatus: vi.fn(),
  getYoutubeSetupCheck: vi.fn(),
  syncYoutube: vi.fn(),
  getYoutubePlaylists: vi.fn(),
  syncYoutubePlaylists: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('../../../services/apiYoutube.js', () => ({
  getYoutubeStatus: api.getYoutubeStatus,
  getYoutubeSetupCheck: api.getYoutubeSetupCheck,
  syncYoutube: api.syncYoutube,
  getYoutubePlaylists: api.getYoutubePlaylists,
  syncYoutubePlaylists: api.syncYoutubePlaylists,
}));
vi.mock('../../ui/Toast', () => ({ default: toast }));
vi.mock('../../../hooks/useSyncSourceSettings', () => ({
  useSyncSourceSettings: () => ({
    loading: false, loadError: null, retry: vi.fn(), enabled: false, setEnabled: vi.fn(), intervalMinutes: 480,
    setIntervalMinutes: vi.fn(), saving: false, status: null, setStatus: vi.fn(), dirty: false, save: vi.fn(),
  }),
}));
vi.mock('../../../hooks/useVideoDownload.js', () => ({
  default: () => ({ active: false, percent: 0, stage: null, context: null, start: vi.fn(), cancel: vi.fn() }),
}));

import { YoutubeTab } from './YoutubeTab';

describe('YoutubeTab setup check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getYoutubePlaylists.mockResolvedValue({ snapshot: null });
  });

  it('shows the needs-operator note with no toast when the gated check is refused', async () => {
    api.getYoutubeSetupCheck.mockRejectedValue(Object.assign(new Error('Host control requires an operator session.'), { code: 'HOST_CONTROL_FORBIDDEN', status: 403 }));
    render(<YoutubeTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Check setup' }));
    expect(await screen.findByText(/Setup check needs an operator session/)).toBeInTheDocument();
    expect(api.getYoutubeSetupCheck).toHaveBeenCalledWith({ silent: true, hostControlOptional: true });
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByText('Setup check failed')).not.toBeInTheDocument();
  });

  it('still toasts an ordinary setup-check failure', async () => {
    api.getYoutubeSetupCheck.mockRejectedValue(new Error('offline'));
    render(<YoutubeTab />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check setup' })); });
    expect(toast.error).toHaveBeenCalledWith('Setup check failed');
  });
});

describe('YoutubeTab load errors and download button (#17971)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows ListLoadError with Retry when the playlist read fails', async () => {
    api.getYoutubePlaylists.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ snapshot: null });
    render(<YoutubeTab />);
    expect(await screen.findByText(/Could not load YouTube playlists — boom/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(await screen.findByText(/Sync playlists to build/)).toBeInTheDocument();
  });

  it('gives each video Download button an accessible name and a 44px mobile hit area', async () => {
    api.getYoutubePlaylists.mockResolvedValue({ snapshot: { playlists: [{ id: 'p1', name: 'Mix', url: 'https://example.com/p', videoCount: 1, videos: [{ id: 'v1', title: 'Clip One', url: 'https://example.com/v' }] }] } });
    render(<YoutubeTab />);
    const btn = await screen.findByRole('button', { name: 'Download Clip One' });
    expect(btn.className).toContain('min-h-[44px]');
    expect(btn.className).toContain('min-w-[44px]');
    expect(btn.className).toContain('pointer-fine:sm:min-h-0');
  });
});
