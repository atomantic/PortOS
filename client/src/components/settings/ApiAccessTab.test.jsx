import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../../services/apiSystem', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getOpenApiSpec: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(),
  }),
}));
// copyToClipboard is unused in these tests but imported by the component.
vi.mock('../../lib/clipboard', () => ({ copyToClipboard: vi.fn() }));

import { getSettings, updateSettings, getOpenApiSpec } from '../../services/apiSystem';
import { ApiAccessTab } from './ApiAccessTab';

beforeEach(() => {
  vi.clearAllMocks();
  getOpenApiSpec.mockResolvedValue({ paths: {} });
  updateSettings.mockResolvedValue({});
});

const renderTab = async () => {
  render(<ApiAccessTab />);
  // Wait for the loading spinner to clear (cards render post-load).
  await waitFor(() => expect(screen.getByText('Voice / TTS')).toBeTruthy());
};

describe('ApiAccessTab', () => {
  it('renders a card per registry API with current state', async () => {
    getSettings.mockResolvedValue({ apiAccess: { voice: { exposed: true, requireAuth: false }, sdapi: { exposed: false, requireAuth: false } } });
    await renderTab();
    expect(screen.getByText('Voice / TTS')).toBeTruthy();
    expect(screen.getByText('Image Gen (A1111-compatible)')).toBeTruthy();
    // voice exposed + no auth → a "passwordless" status chip is present
    // ("passwordless" also appears in the intro copy, hence getAllByText);
    // sdapi not exposed → "not exposed".
    expect(screen.getAllByText('passwordless').length).toBeGreaterThan(0);
    expect(screen.getByText('not exposed')).toBeTruthy();
  });

  it('CONTRACT: toggling one API preserves the other API\'s persisted flags', async () => {
    // The server PUT /api/settings shallow-merges top-level keys, so the client
    // MUST send the full apiAccess map. Toggling voice must not wipe sdapi.
    getSettings.mockResolvedValue({
      apiAccess: {
        voice: { exposed: false, requireAuth: false },
        sdapi: { exposed: true, requireAuth: true },
      },
    });
    await renderTab();

    // Toggle voice's "Expose on the network" on.
    const exposeToggles = screen.getAllByLabelText(/Expose on the network/i);
    fireEvent.click(exposeToggles[0]); // first card = voice

    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const sentBody = updateSettings.mock.calls[0][0];
    // sdapi's flags must be included verbatim, not dropped.
    expect(sentBody.apiAccess.sdapi).toEqual({ exposed: true, requireAuth: true });
    expect(sentBody.apiAccess.voice.exposed).toBe(true);
  });

  it('CONTRACT: disables ALL toggles while a save is in flight (serialize saves)', async () => {
    // Overlapping saves could let an older full-snapshot PUT land last and
    // clobber a newer toggle. While one save is pending, every toggle (this
    // card's and the other card's) must be disabled so saves serialize.
    getSettings.mockResolvedValue({
      apiAccess: { voice: { exposed: false, requireAuth: false }, sdapi: { exposed: false, requireAuth: false } },
    });
    let resolveSave;
    updateSettings.mockReturnValue(new Promise((res) => { resolveSave = res; }));
    await renderTab();

    const exposeToggles = screen.getAllByLabelText(/Expose on the network/i);
    fireEvent.click(exposeToggles[0]); // start voice save (never resolves yet)

    // While the voice save is in flight, the OTHER card's expose toggle is disabled.
    await waitFor(() => {
      const toggles = screen.getAllByLabelText(/Expose on the network/i);
      expect(toggles[1].disabled).toBe(true);
    });

    // Let the save settle inside act() so the post-save setState (clearing the
    // in-flight flag) is wrapped rather than firing after the test returns.
    await act(async () => { resolveSave({}); });
  });

  it('reverts optimistic state when the save fails', async () => {
    getSettings.mockResolvedValue({ apiAccess: { voice: { exposed: false, requireAuth: false }, sdapi: { exposed: false, requireAuth: false } } });
    updateSettings.mockRejectedValue(new Error('boom'));
    await renderTab();
    const exposeToggles = screen.getAllByLabelText(/Expose on the network/i);
    fireEvent.click(exposeToggles[0]);
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    // After the rejection, voice expose should revert to unchecked.
    await waitFor(() => {
      const toggles = screen.getAllByLabelText(/Expose on the network/i);
      expect(toggles[0].checked).toBe(false);
    });
  });

  it('falls back to defaults (not-exposed) when apiAccess is absent', async () => {
    getSettings.mockResolvedValue({});
    await renderTab();
    // Both cards show "not exposed".
    expect(screen.getAllByText('not exposed').length).toBe(2);
  });
});
