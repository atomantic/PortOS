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
vi.mock('../../../services/api', () => api);
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
