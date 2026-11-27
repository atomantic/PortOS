import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/apiSystem', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getOpenApiSpec: vi.fn(),
  getApiCatalog: vi.fn(),
}));
vi.mock('../ui/Toast');
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
  it('keeps access controls unavailable after a failed read until retry restores the saved policies', async () => {
    // A failed settings read is not a fresh install. Saving defaults here could
    // remove a protected API's password requirement and erase other grants.
    const saved = {
      apiAccess: {
        voice: { exposed: true, requireAuth: true },
        sdapi: { exposed: true, requireAuth: false },
      },
      agentContext: {
        enabled: true,
        profile: 'summary',
        scopes: ['brain', 'identity'],
        actions: {
          readPortos: true, writePortos: true, callToolRecipes: true,
          manageEidoverse: false, visitEidoversePeers: true,
        },
      },
    };
    let resolveRetry;
    getSettings.mockRejectedValueOnce(new Error('temporarily offline'));
    render(<MemoryRouter><ApiAccessTab /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load API access settings');
    const expectNoWritableControls = () => {
      for (const control of [...screen.queryAllByRole('checkbox'), ...screen.queryAllByRole('combobox')]) {
        expect(control).toBeDisabled();
      }
      expect(updateSettings).not.toHaveBeenCalled();
    };
    expectNoWritableControls();
    getSettings.mockReturnValueOnce(new Promise((resolve) => { resolveRetry = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    expectNoWritableControls();

    await act(async () => { resolveRetry(saved); });
    expect(await screen.findByText('Voice / TTS')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    const exposure = screen.getByLabelText('Expose on the network');
    expect(exposure).toBeChecked();
    expect(screen.getByLabelText('Require auth (password)')).toBeChecked();
    expect(screen.getByLabelText('Enable local MCP context')).toBeChecked();
    expect(screen.getByLabelText('Disclosure profile')).toHaveValue('summary');
    expect(screen.getByLabelText('Brain')).toBeChecked();
    expect(screen.getByLabelText('Identity export')).toBeChecked();
    expect(screen.getByLabelText('Navigation')).not.toBeChecked();
    expect(screen.getByLabelText('Allow semantic PortOS updates')).toBeChecked();

    fireEvent.click(exposure);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      apiAccess: { ...saved.apiAccess, voice: { ...saved.apiAccess.voice, exposed: false } },
    }, { silent: true }));
    await waitFor(() => expect(screen.getByLabelText('Enable local MCP context')).toBeEnabled());
    fireEvent.click(screen.getByLabelText('Allow semantic PortOS reads'));
    await waitFor(() => expect(updateSettings).toHaveBeenLastCalledWith({
      agentContext: { ...saved.agentContext, actions: { ...saved.agentContext.actions, browserVaultFill: false, readPortos: false } },
    }, { silent: true }));
  });

  it('renders voice exposure settings while hiding retired SDAPI controls', async () => {
    getSettings.mockResolvedValue({
      apiAccess: {
        voice: { exposed: true, requireAuth: false },
        sdapi: { exposed: true, requireAuth: false },
      },
    });
    await renderTab();
    expect(screen.getByLabelText('Expose on the network')).toBeChecked();
    expect(screen.getByLabelText('Require auth (password)')).not.toBeChecked();
    expect(screen.queryByText('Image Gen (A1111-compatible)')).toBeNull();
  });

  it('CONTRACT: toggling voice preserves retired SDAPI settings', async () => {
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
    fireEvent.click(screen.getByLabelText('Expose on the network'));

    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const sentBody = updateSettings.mock.calls[0][0];
    // sdapi's flags must be included verbatim, not dropped.
    expect(sentBody.apiAccess.sdapi).toEqual({ exposed: true, requireAuth: true });
    expect(sentBody.apiAccess.voice.exposed).toBe(true);
  });

  it('CONTRACT: disables ALL toggles while a save is in flight (serialize saves)', async () => {
    getSettings.mockResolvedValue({ apiAccess: { voice: { exposed: true, requireAuth: false } } });
    let resolveSave;
    updateSettings.mockReturnValue(new Promise((res) => { resolveSave = res; }));
    await renderTab();

    const exposure = screen.getByLabelText('Expose on the network');
    const requireAuth = screen.getByLabelText('Require auth (password)');
    const agentContext = screen.getByLabelText('Enable local MCP context');
    expect(requireAuth).toBeEnabled();
    expect(agentContext).toBeEnabled();
    fireEvent.click(requireAuth);

    await waitFor(() => {
      expect(exposure).toBeDisabled();
      expect(requireAuth).toBeDisabled();
      expect(agentContext).toBeDisabled();
    });

    // Let the save settle inside act() so the post-save setState (clearing the
    // in-flight flag) is wrapped rather than firing after the test returns.
    await act(async () => { resolveSave({}); });
  });

  it('reverts optimistic state when the save fails', async () => {
    getSettings.mockResolvedValue({ apiAccess: { voice: { exposed: false, requireAuth: false } } });
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
    expect(screen.getByText('not exposed')).toBeTruthy();
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
    expect(screen.getByLabelText('Allow saved read recipes').checked).toBe(false);
    expect(screen.getByLabelText('Allow private Eidoverse world management').checked).toBe(false);
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
        actions: { readPortos: false, writePortos: false, callToolRecipes: false, manageEidoverse: false, visitEidoversePeers: false, browserVaultFill: false },
      },
    }, { silent: true }));
  });

  it('persists semantic MCP grants independently of context scopes', async () => {
    getSettings.mockResolvedValue({
      agentContext: {
        enabled: true,
        profile: 'metadata',
        scopes: ['navigation'],
        actions: { readPortos: false, writePortos: false, callToolRecipes: false, manageEidoverse: false },
      },
    });
    await renderTab();
    fireEvent.click(screen.getByLabelText('Allow semantic PortOS reads'));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      agentContext: {
        enabled: true,
        profile: 'metadata',
        scopes: ['navigation'],
        actions: { readPortos: true, writePortos: false, callToolRecipes: false, manageEidoverse: false, visitEidoversePeers: false, browserVaultFill: false },
      },
    }, { silent: true }));
  });

  it('persists the dedicated Eidoverse MCP grant independently', async () => {
    getSettings.mockResolvedValue({});
    await renderTab();
    fireEvent.click(screen.getByLabelText('Allow private Eidoverse world management'));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      agentContext: {
        enabled: false,
        profile: 'metadata',
        scopes: ['navigation', 'workspaces'],
        actions: { readPortos: false, writePortos: false, callToolRecipes: false, manageEidoverse: true, visitEidoversePeers: false, browserVaultFill: false },
      },
    }, { silent: true }));
  });

  it('persists the default-off website login fill grant independently (#17397)', async () => {
    getSettings.mockResolvedValue({});
    await renderTab();
    expect(screen.getByLabelText('Allow website login fill').checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Allow website login fill'));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      agentContext: {
        enabled: false,
        profile: 'metadata',
        scopes: ['navigation', 'workspaces'],
        actions: { readPortos: false, writePortos: false, callToolRecipes: false, manageEidoverse: false, visitEidoversePeers: false, browserVaultFill: true },
      },
    }, { silent: true }));
  });

  it('persists the saved-recipe MCP grant independently', async () => {
    getSettings.mockResolvedValue({});
    await renderTab();
    fireEvent.click(screen.getByLabelText('Allow saved read recipes'));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      agentContext: {
        enabled: false,
        profile: 'metadata',
        scopes: ['navigation', 'workspaces'],
        actions: { readPortos: false, writePortos: false, callToolRecipes: true, manageEidoverse: false, visitEidoversePeers: false, browserVaultFill: false },
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
