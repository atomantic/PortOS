import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  getHfTokenStatus: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(),
  }),
}));

import { getHfTokenStatus } from '../../services/api';
import MidiGatedModal from './MidiGatedModal';

const REPO = 'MuScriptor/muscriptor-medium';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MidiGatedModal token-aware branching', () => {
  it('shows the license-only view (no token entry) when a token is already configured', async () => {
    getHfTokenStatus.mockResolvedValue({ hfTokenPresent: true, source: 'stored' });
    const onSaved = vi.fn();
    render(<MidiGatedModal open repo={REPO} onSaved={onSaved} onClose={vi.fn()} />);

    // Resolves to the license-accept branch.
    await waitFor(() => expect(screen.getByText('Accept the model license')).toBeTruthy());
    // Explains the token is already present and does NOT nag for a new one.
    expect(screen.getByText(/token is already configured/i)).toBeTruthy();
    expect(screen.queryByPlaceholderText('hf_…')).toBeNull();

    // Retry re-fires the captured transcription.
    fireEvent.click(screen.getByText('Retry transcription'));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('lets the user drop to token entry when the stored token might be stale', async () => {
    getHfTokenStatus.mockResolvedValue({ hfTokenPresent: true, source: 'env' });
    render(<MidiGatedModal open repo={REPO} onSaved={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Accept the model license')).toBeTruthy());
    fireEvent.click(screen.getByText('Use a different token'));
    // Now the paste form (HfTokenBanner) is visible.
    expect(screen.getByPlaceholderText('hf_…')).toBeTruthy();
  });

  it('shows the token-entry banner when no token is configured', async () => {
    getHfTokenStatus.mockResolvedValue({ hfTokenPresent: false, source: 'none' });
    render(<MidiGatedModal open repo={REPO} onSaved={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('HuggingFace access required')).toBeTruthy());
    expect(screen.getByPlaceholderText('hf_…')).toBeTruthy();
  });

  it('falls back to the token-entry banner if the status check fails', async () => {
    getHfTokenStatus.mockRejectedValue(new Error('offline'));
    render(<MidiGatedModal open repo={REPO} onSaved={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('HuggingFace access required')).toBeTruthy());
    expect(screen.getByPlaceholderText('hf_…')).toBeTruthy();
  });

  it('re-checks token status on each reopen so a token saved on a prior pass flips the view', async () => {
    // First open: no token → token-entry banner.
    getHfTokenStatus.mockResolvedValueOnce({ hfTokenPresent: false, source: 'none' });
    const { rerender } = render(
      <MidiGatedModal open repo={REPO} onSaved={vi.fn()} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByPlaceholderText('hf_…')).toBeTruthy());

    // Modal closes (e.g. token saved, transcription re-fires), then the license
    // 403 reopens it — the status must be re-fetched, not reused from pass one.
    rerender(<MidiGatedModal open={false} repo={REPO} onSaved={vi.fn()} onClose={vi.fn()} />);
    getHfTokenStatus.mockResolvedValueOnce({ hfTokenPresent: true, source: 'stored' });
    rerender(<MidiGatedModal open repo={REPO} onSaved={vi.fn()} onClose={vi.fn()} />);

    // View flips to the license-accept branch — no stale "token missing" nag.
    await waitFor(() => expect(screen.getByText('Accept the model license')).toBeTruthy());
    expect(screen.queryByPlaceholderText('hf_…')).toBeNull();
    expect(getHfTokenStatus).toHaveBeenCalledTimes(2);
  });
});
