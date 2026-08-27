import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/apiSystem', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getOpenApiSpec: vi.fn(),
  getApiCatalog: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(),
  }),
}));
// copyToClipboard is unused in these tests but imported by the component.
vi.mock('../../lib/clipboard', () => ({ copyToClipboard: vi.fn() }));

import { getApiCatalog, getSettings, updateSettings, getOpenApiSpec } from '../../services/apiSystem';
import { ApiAccessTab } from './ApiAccessTab';

beforeEach(() => {
  vi.clearAllMocks();
  getOpenApiSpec.mockResolvedValue({ paths: {} });
  getApiCatalog.mockResolvedValue({
    externallyExposableApis: [
      {
        id: 'voice', label: 'Voice / TTS', description: 'Text-to-speech synthesis.', publicBase: '/api/voice/public',
        example: { method: 'POST', path: '/api/voice/public/synthesize', body: { text: 'Hello from PortOS' }, output: 'speech.wav' },
      },
      {
        id: 'sdapi', label: 'Image Gen (A1111-compatible)', description: 'Text-to-image generation.', publicBase: '/sdapi/v1',
        example: { method: 'POST', path: '/sdapi/v1/txt2img', body: { prompt: 'a neon city' } },
      },
    ],
  });
  updateSettings.mockResolvedValue({});
});

const renderTab = async () => {
  render(<MemoryRouter><ApiAccessTab /></MemoryRouter>);
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

  it('persists registry settings by settingsKey instead of display id', async () => {
    getSettings.mockResolvedValue({ apiAccess: { voice: { exposed: true, requireAuth: false } } });
    getApiCatalog.mockResolvedValue({
      externallyExposableApis: [{
        id: 'voice-display', settingsKey: 'voice', label: 'Voice / TTS', description: 'Text-to-speech synthesis.',
        publicBase: '/api/voice/public', example: { method: 'GET', path: '/api/voice/public/voices' },
      }],
    });
    await renderTab();
    expect(screen.getByLabelText('Expose on the network').checked).toBe(true);
    fireEvent.click(screen.getByLabelText('Require auth (password)'));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings.mock.calls[0][0].apiAccess).toMatchObject({
      voice: { exposed: true, requireAuth: true },
    });
    expect(updateSettings.mock.calls[0][0].apiAccess['voice-display']).toBeUndefined();
  });

  it('distinguishes a failed catalog load from an empty registry and supports retry', async () => {
    getSettings.mockResolvedValue({});
    getApiCatalog
      .mockRejectedValueOnce(new Error('temporarily offline'))
      .mockResolvedValueOnce({
        externallyExposableApis: [{
          id: 'voice', settingsKey: 'voice', label: 'Voice / TTS', description: 'Text-to-speech synthesis.',
          publicBase: '/api/voice/public', example: { method: 'GET', path: '/api/voice/public/voices' },
        }],
      });
    render(<MemoryRouter><ApiAccessTab /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily offline');
    expect(screen.queryByText('Voice / TTS')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Voice / TTS')).toBeTruthy();
  });

  it('defaults agent context to disabled metadata with minimal scopes', async () => {
    getSettings.mockResolvedValue({});
    await renderTab();
    expect(screen.getByLabelText('Enable local MCP context').checked).toBe(false);
    expect(screen.getByLabelText('Navigation').checked).toBe(true);
    expect(screen.getByLabelText('Workspaces').checked).toBe(true);
    expect(screen.getByLabelText('Brain').checked).toBe(false);
    expect(screen.getByLabelText('Disclosure profile').value).toBe('metadata');
    expect(screen.getByLabelText('Allow semantic PortOS reads').checked).toBe(false);
    expect(screen.getByLabelText('Allow semantic PortOS updates').checked).toBe(false);
  });

  it('persists the complete agent-context opt-in configuration', async () => {
    getSettings.mockResolvedValue({});
    await renderTab();
    fireEvent.click(screen.getByLabelText('Enable local MCP context'));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      agentContext: {
        enabled: true,
        profile: 'metadata',
        scopes: ['navigation', 'workspaces'],
        actions: { readPortos: false, writePortos: false },
      },
    }, { silent: true }));
  });

  it('persists semantic MCP grants independently of context scopes', async () => {
    getSettings.mockResolvedValue({
      agentContext: { enabled: true, profile: 'metadata', scopes: ['navigation'], actions: { readPortos: false, writePortos: false } },
    });
    await renderTab();
    fireEvent.click(screen.getByLabelText('Allow semantic PortOS reads'));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      agentContext: {
        enabled: true,
        profile: 'metadata',
        scopes: ['navigation'],
        actions: { readPortos: true, writePortos: false },
      },
    }, { silent: true }));
  });

  it('serializes agent-context scope saves with all API toggles', async () => {
    getSettings.mockResolvedValue({
      agentContext: { enabled: true, profile: 'metadata', scopes: ['navigation', 'workspaces'] },
    });
    let resolveSave;
    updateSettings.mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }));
    await renderTab();
    fireEvent.click(screen.getByLabelText('Brain'));

    await waitFor(() => {
      expect(screen.getAllByLabelText(/Expose on the network/i)[0].disabled).toBe(true);
      expect(screen.getByLabelText('Disclosure profile').disabled).toBe(true);
    });
    expect(updateSettings.mock.calls[0][0].agentContext.scopes).toEqual(['navigation', 'workspaces', 'brain']);
    await act(async () => { resolveSave({}); });
  });
});
