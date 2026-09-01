import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/api', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getImageGenStatus: vi.fn(),
  generateImage: vi.fn(),
  registerTool: vi.fn(),
  updateTool: vi.fn(),
  getToolsList: vi.fn(),
  saveHfToken: vi.fn(),
  clearHfToken: vi.fn(),
  listAgyImageModels: vi.fn(),
}));
vi.mock('../../hooks/useHfTokenStatus', () => ({
  useHfTokenStatus: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(),
  }),
}));
// LocalSetupPanel has its own SSE/install-stream deps — stub it out; this suite
// only cares that the Local tab hosts a python-path panel.
vi.mock('./LocalSetupPanel', () => ({
  default: ({ pythonPath }) => <div data-testid="local-setup-panel">{pythonPath}</div>,
}));
vi.mock('../../hooks/useMediaJobSse', () => ({
  useMediaJobSse: () => ({ attach: vi.fn(), close: vi.fn() }),
}));

import {
  getSettings, getToolsList, updateSettings, listAgyImageModels, getImageGenStatus, generateImage,
} from '../../services/api';
import { useHfTokenStatus } from '../../hooks/useHfTokenStatus';
import { ImageGenTab, MEDIA_TABS } from './ImageGenTab';
import { IMAGE_GEN_MODE } from '../../lib/imageGenBackends';

const renderTab = async (initialEntries = ['/media/image']) => {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <ImageGenTab />
    </MemoryRouter>,
  );
  // Cards render only after the settings fetch resolves.
  await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy());
};

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({
    imageGen: {
      mode: 'external',
      external: { sdapiUrl: 'http://localhost:7860' },
      local: { pythonPath: '/usr/bin/python3' },
      codex: { enabled: false },
      expose: { a1111: false },
    },
  });
  getToolsList.mockResolvedValue([]);
  useHfTokenStatus.mockReturnValue({ present: false, source: 'none', refresh: vi.fn() });
  updateSettings.mockResolvedValue({});
  listAgyImageModels.mockResolvedValue({ models: ['gemini-image', 'custom/image-v2'], error: null });
});

describe('ImageGenTab grouped tabs', () => {
  it('renders a pills sub-nav with all media-settings groups', async () => {
    await renderTab();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    for (const label of ['Backend', 'External', 'Local', 'Codex CLI', 'Grok CLI', 'Agy CLI', 'Tokens', 'Expose', 'Test']) {
      expect(tabs.some((t) => t.includes(label))).toBe(true);
    }
  });

  it('defaults to the Backend tab and shows the mode cards', async () => {
    await renderTab();
    expect(screen.getByRole('heading', { name: 'Backend' })).toBeTruthy();
    expect(screen.getByText('External SD API')).toBeTruthy();
    expect(screen.getByText('Local (mflux)')).toBeTruthy();
    // Sections from other tabs are not mounted in the default view.
    expect(screen.queryByText('HuggingFace Token')).toBeNull();
    expect(screen.queryByText('Test Render')).toBeNull();
  });

  it('switches to the External tab and shows only that group', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('tab', { name: /External/i }));
    expect(screen.getByText('External AUTOMATIC1111 / Forge URL')).toBeTruthy();
    // Backend mode cards are no longer mounted.
    expect(screen.queryByText('External SD API')).toBeNull();
  });

  it('hosts the python-path panel on the Local tab regardless of active mode', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('tab', { name: /^Local/i }));
    expect(screen.getByTestId('local-setup-panel')).toBeTruthy();
  });

  it('keeps LocalSetupPanel mounted (hidden) after leaving the Local tab so an in-flight install stream is not torn down', async () => {
    await renderTab();
    // Not mounted until first visited (avoids a cold python-env probe).
    expect(screen.queryByTestId('local-setup-panel')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /^Local/i }));
    const panel = screen.getByTestId('local-setup-panel');
    // Switch away — the panel must stay in the DOM (its install EventSource
    // survives), just visually hidden, rather than unmounting.
    fireEvent.click(screen.getByRole('tab', { name: /Backend/i }));
    expect(screen.getByTestId('local-setup-panel')).toBe(panel);
    expect(panel.closest('div.hidden')).not.toBeNull();
  });

  it('deep-links the active sub-tab from the mediaTab search param', async () => {
    await renderTab(['/media/image?mediaTab=tokens']);
    // The Tokens group renders immediately without a click.
    expect(screen.getByRole('heading', { name: 'HuggingFace Token' })).toBeTruthy();
    const tokensTab = screen.getByRole('tab', { name: /Tokens/i });
    expect(tokensTab.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the detailed managed-token source labels while reading shared status', async () => {
    useHfTokenStatus.mockReturnValue({ present: true, source: 'cli', refresh: vi.fn() });
    await renderTab(['/media/image?mediaTab=tokens']);

    expect(screen.getByText(/~\/\.cache\/huggingface\/token — set via `hf auth login`/i)).toBeTruthy();
  });

  it('keeps the global Save + Test Connection bar visible on every tab', async () => {
    await renderTab();
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Test Connection/i })).toBeTruthy();
    // Still present after switching to a non-backend tab.
    fireEvent.click(screen.getByRole('tab', { name: /Expose/i }));
    expect(screen.getByText('Expose as A1111 API on the Tailnet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeTruthy();
  });

  it('tags every image-gen backend onto a tab, so a new backend cannot silently probe the default instead', () => {
    const probed = MEDIA_TABS.map((t) => t.probeMode).filter(Boolean);
    expect([...probed].sort()).toEqual([...Object.values(IMAGE_GEN_MODE)].sort());
  });

  it('probes the provider whose tab is open, not the saved default backend', async () => {
    getImageGenStatus.mockResolvedValue({ connected: true, mode: 'agy', model: 'agy 1.2.3' });
    await renderTab();

    // On a provider tab the probe targets THAT provider — testing from the Agy
    // tab must not report the saved default (external/codex) backend.
    fireEvent.click(screen.getByRole('tab', { name: /Agy CLI/i }));
    fireEvent.click(screen.getByRole('button', { name: /Test Connection/i }));
    await waitFor(() => expect(getImageGenStatus).toHaveBeenCalledWith('agy'));

    getImageGenStatus.mockResolvedValue({ connected: true, mode: 'grok', model: 'grok-cli 0.0.30' });
    fireEvent.click(screen.getByRole('tab', { name: /Grok CLI/i }));
    fireEvent.click(screen.getByRole('button', { name: /Test Connection/i }));
    await waitFor(() => expect(getImageGenStatus).toHaveBeenLastCalledWith('grok'));
  });

  it('falls back to the saved default backend on tabs with no provider of their own', async () => {
    getImageGenStatus.mockResolvedValue({ connected: true, mode: 'external', model: 'flux-v1' });
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: /Test Connection/i }));
    await waitFor(() => expect(screen.getByText(/Ready — external — flux-v1/)).toBeTruthy());
    expect(getImageGenStatus).toHaveBeenCalledWith(undefined);
  });

  it('hides a probe result once the user switches to another tab', async () => {
    getImageGenStatus.mockResolvedValue({ connected: true, mode: 'grok', model: 'grok-cli 0.0.30' });
    await renderTab();
    fireEvent.click(screen.getByRole('tab', { name: /Grok CLI/i }));
    fireEvent.click(screen.getByRole('button', { name: /Test Connection/i }));
    await waitFor(() => expect(screen.getByText(/grok — grok-cli 0\.0\.30/)).toBeTruthy());

    fireEvent.click(screen.getByRole('tab', { name: /Agy CLI/i }));
    expect(screen.queryByText(/grok — grok-cli 0\.0\.30/)).toBeNull();
  });

  it('keeps an inconclusive local probe distinct from an unavailable runtime', async () => {
    getImageGenStatus.mockResolvedValue({
      connected: false,
      mode: 'local',
      readiness: 'unknown',
      reason: 'Could not verify the configured Python runtime',
    });
    await renderTab();
    fireEvent.click(screen.getByRole('tab', { name: /^Local/i }));
    fireEvent.click(screen.getByRole('button', { name: /Test Connection/i }));

    await waitFor(() => expect(screen.getByText(/Could not verify — Could not verify the configured Python runtime/)).toBeTruthy());
  });

  it('never shows an in-flight probe result under the tab the user switched to', async () => {
    // Probe started on Grok, answered only after the user moved to Agy — the
    // late response must not surface as if it described Agy.
    let resolveProbe;
    getImageGenStatus.mockReturnValue(new Promise((resolve) => { resolveProbe = resolve; }));
    await renderTab();
    fireEvent.click(screen.getByRole('tab', { name: /Grok CLI/i }));
    fireEvent.click(screen.getByRole('button', { name: /Test Connection/i }));

    fireEvent.click(screen.getByRole('tab', { name: /Agy CLI/i }));
    resolveProbe({ connected: true, mode: 'grok', model: 'grok-cli 0.0.30' });
    await waitFor(() => expect(screen.getByRole('button', { name: /Test Connection/i }).disabled).toBe(false));
    expect(screen.queryByText(/grok — grok-cli 0\.0\.30/)).toBeNull();

    // Going back to Grok shows the answer that was actually asked for there.
    fireEvent.click(screen.getByRole('tab', { name: /Grok CLI/i }));
    expect(screen.getByText(/grok — grok-cli 0\.0\.30/)).toBeTruthy();
  });

  it('preserves the save behavior — dirtying a field enables Save and PUTs the full imageGen patch', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('tab', { name: /External/i }));
    const urlInput = screen.getByPlaceholderText('http://localhost:7860');
    fireEvent.change(urlInput, { target: { value: 'http://localhost:9999' } });
    const saveBtn = screen.getByRole('button', { name: /^Save$/ });
    expect(saveBtn.disabled).toBe(false);
    fireEvent.click(saveBtn);
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const patch = updateSettings.mock.calls[0][0];
    expect(patch.imageGen.external.sdapiUrl).toBe('http://localhost:9999');
    expect(patch.imageGen.mode).toBe('external');
    expect(patch.imageGen).toHaveProperty('codex');
    expect(patch.imageGen).toHaveProperty('grok');
    expect(patch.imageGen).toHaveProperty('agy');
    expect(patch.imageGen).toHaveProperty('expose');
  });

  it('the videoGen save body round-trips sibling keys the tab does not edit (#3231 Phase 4)', async () => {
    // The settings PUT replaces top-level slices wholesale, so if this wire
    // body ever drops the loaded slice's sibling keys, a Defaults-tab save
    // erases videoGen.defaultModelId (read by pipeline video stages). The
    // server suite can't see this — it validates whatever body arrives — so
    // the exact wire body is pinned HERE.
    getSettings.mockResolvedValue({
      imageGen: { mode: 'external', external: { sdapiUrl: 'http://localhost:7860' } },
      videoGen: { mode: 'grok', defaultModelId: 'ltx23_distilled_q4' },
    });
    await renderTab(['/media/image?mediaTab=defaults']);
    const videoSelect = screen.getByLabelText(/Default video backend/i);
    expect(videoSelect.value).toBe('grok');
    fireEvent.change(videoSelect, { target: { value: 'local' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const patch = updateSettings.mock.calls[0][0];
    expect(patch.videoGen).toEqual({ mode: 'local', defaultModelId: 'ltx23_distilled_q4', displaySleep: true });
  });
});

describe('ImageGenTab — Test Render backend picker (#4128)', () => {
  const multiBackendSettings = {
    imageGen: {
      mode: 'external',
      external: { sdapiUrl: 'http://localhost:7860' },
      local: { pythonPath: '' },
      codex: { enabled: false },
      grok: { enabled: true, grokPath: 'grok' },
      agy: { enabled: true, agyPath: 'agy' },
      expose: { a1111: false },
    },
  };

  it('offers every enabled backend and marks the saved default as the initial pick', async () => {
    getSettings.mockResolvedValue(multiBackendSettings);
    await renderTab(['/media/image?mediaTab=test']);
    const select = screen.getByLabelText('Backend');
    expect(select.value).toBe('external');
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['grok', 'agy', 'external']);
    // Local has no python path and codex is disabled — neither is renderable,
    // so neither may be offered.
    expect(options).not.toContain('local');
    expect(options).not.toContain('codex');
    expect(screen.getByText(/Send a prompt through External/)).toBeTruthy();
  });

  it('renders through the picked backend instead of the saved default', async () => {
    getSettings.mockResolvedValue(multiBackendSettings);
    generateImage.mockResolvedValue({ mode: 'grok', path: '/data/renders/test.png', filename: 'test.png' });
    await renderTab(['/media/image?mediaTab=test']);
    fireEvent.change(screen.getByLabelText('Backend'), { target: { value: 'grok' } });
    expect(screen.getByText(/Send a prompt through Grok/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Render Test Image/i }));
    await waitFor(() => expect(generateImage).toHaveBeenCalled());
    expect(generateImage.mock.calls[0][0].mode).toBe('grok');
  });

  it('keeps the saved default selectable even when it is not otherwise renderable', async () => {
    // External is the saved default with a blank URL: the server still routes
    // the render there, so the select must not silently show a different
    // backend than the button uses.
    getSettings.mockResolvedValue({
      imageGen: {
        mode: 'external',
        external: { sdapiUrl: '' },
        grok: { enabled: true, grokPath: 'grok' },
      },
    });
    generateImage.mockResolvedValue({ mode: 'external', path: '/data/renders/test.png', filename: 'test.png' });
    await renderTab(['/media/image?mediaTab=test']);
    const select = screen.getByLabelText('Backend');
    expect(select.value).toBe('external');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['external', 'grok']);
    fireEvent.click(screen.getByRole('button', { name: /Render Test Image/i }));
    await waitFor(() => expect(generateImage).toHaveBeenCalled());
    expect(generateImage.mock.calls[0][0].mode).toBe('external');
  });

  it('falls a pick back to the saved default once that backend is disabled and saved', async () => {
    getSettings.mockResolvedValue(multiBackendSettings);
    generateImage.mockResolvedValue({ mode: 'external', path: '/data/renders/test.png', filename: 'test.png' });
    await renderTab(['/media/image?mediaTab=test']);
    fireEvent.change(screen.getByLabelText('Backend'), { target: { value: 'grok' } });

    // Disable Grok on its own tab and save — the pick is now unrenderable.
    fireEvent.click(screen.getByRole('tab', { name: /Grok CLI/i }));
    fireEvent.click(screen.getByLabelText(/Enable Grok/i));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('tab', { name: /^Test$/i }));
    const select = screen.getByLabelText('Backend');
    expect(select.value).toBe('external');
    expect(Array.from(select.options).map((o) => o.value)).not.toContain('grok');
    fireEvent.click(screen.getByRole('button', { name: /Render Test Image/i }));
    await waitFor(() => expect(generateImage).toHaveBeenCalled());
    expect(generateImage.mock.calls[0][0].mode).toBe('external');
  });
});

describe('ImageGenTab — Agy CLI section', () => {
  it('loads installed models, allows a custom model id, and saves the Agy slice', async () => {
    getSettings.mockResolvedValue({
      imageGen: {
        mode: 'agy',
        agy: { enabled: true, agyPath: '/opt/agy', model: 'gemini-image' },
      },
    });
    await renderTab(['/media/image?mediaTab=agy']);
    await waitFor(() => expect(listAgyImageModels).toHaveBeenCalledWith({ silent: true }));
    const modelInput = screen.getByLabelText(/^Agent model/);
    expect(modelInput.value).toBe('gemini-image');
    fireEvent.change(modelInput, { target: { value: 'custom/image-v3' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings.mock.calls[0][0].imageGen.agy).toEqual(expect.objectContaining({
      enabled: true,
      agyPath: '/opt/agy',
      model: 'custom/image-v3',
    }));
  });

  it('render-defaults tab pins a backend + model per surface and saves the slice (#3231)', async () => {
    getSettings.mockResolvedValue({
      imageGen: { mode: 'local', agy: { enabled: true } },
      renderDefaults: { 'universe-bible': { imageMode: 'codex' } },
    });
    await renderTab(['/media/image?mediaTab=defaults']);
    // Existing pin loads into its select.
    const bibleSelect = await screen.findByLabelText('Universe Bible & canon renders');
    expect(bibleSelect.value).toBe('codex');
    // Pin a model-capable backend on another surface → model input appears.
    const spriteSelect = screen.getByLabelText('Sprite references & anchors');
    fireEvent.change(spriteSelect, { target: { value: 'agy' } });
    const modelInput = screen.getByLabelText('Sprite references & anchors model');
    fireEvent.change(modelInput, { target: { value: 'gemini-3.6-flash-low' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    // The saved wire body carries exactly the pinned entries — no 'auto' no-ops.
    expect(updateSettings.mock.calls[0][0].renderDefaults).toEqual({
      'universe-bible': { imageMode: 'codex' },
      'sprite-reference': { imageMode: 'agy', imageModel: 'gemini-3.6-flash-low' },
    });
  });

  it('grok pins never show a model input — its backend has no model knob (#3231)', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'local' } });
    await renderTab(['/media/image?mediaTab=defaults']);
    const select = await screen.findByLabelText('LoRA training datasets');
    fireEvent.change(select, { target: { value: 'grok' } });
    expect(screen.queryByLabelText('LoRA training datasets model')).toBeNull();
  });

  it('names the fixed server-side image model as a read-only fact (#3231)', async () => {
    getSettings.mockResolvedValue({
      imageGen: { mode: 'agy', agy: { enabled: true } },
    });
    await renderTab(['/media/image?mediaTab=agy']);
    await waitFor(() => expect(listAgyImageModels).toHaveBeenCalled());
    // The image model is fixed by Antigravity — the section must state the
    // concrete id rather than implying an imagen-* picker exists.
    expect(screen.getByText('imagen-3.0-generate-002')).toBeTruthy();
    expect(screen.getByText(/not selectable through the CLI/i)).toBeTruthy();
  });

  it('states that Agy is text-to-image only', async () => {
    await renderTab(['/media/image?mediaTab=agy']);
    expect(screen.getByText(/Image editing is not supported/i)).toBeTruthy();
  });
});

describe('ImageGenTab — Grok CLI section (#2859)', () => {
  it('shows the enable toggle and hides the config fields until enabled', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('tab', { name: /Grok CLI/i }));
    expect(screen.getByRole('heading', { name: 'Grok CLI Imagegen' })).toBeTruthy();
    const toggle = screen.getByLabelText(/Enable Grok Imagegen/i);
    expect(toggle.checked).toBe(false);
    expect(screen.queryByPlaceholderText('grok (uses $PATH)')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByPlaceholderText('grok (uses $PATH)')).toBeTruthy();
    expect(screen.getByLabelText(/Default aspect ratio/i)).toBeTruthy();
  });

  it('adds a Grok backend tile only when enabled, and saves the grok slice', async () => {
    getSettings.mockResolvedValue({
      imageGen: {
        mode: 'external',
        external: { sdapiUrl: 'http://localhost:7860' },
        grok: { enabled: true, grokPath: '/opt/grok', aspectRatio: '16:9' },
      },
    });
    await renderTab();
    // Enabled grok surfaces a backend tile on the Backend tab (scope the
    // query to the tile description — the tab bar also says "Grok CLI").
    expect(screen.getByText(/Route through the Grok Build CLI/i)).toBeTruthy();
    // Dirty the grok path and save — the patch carries the grok slice.
    fireEvent.click(screen.getByRole('tab', { name: /Grok CLI/i }));
    fireEvent.change(screen.getByPlaceholderText('grok (uses $PATH)'), { target: { value: '/usr/local/bin/grok' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const patch = updateSettings.mock.calls[0][0];
    expect(patch.imageGen.grok).toEqual(expect.objectContaining({
      enabled: true, grokPath: '/usr/local/bin/grok', aspectRatio: '16:9',
    }));
  });

  it('falls the mode back to local when grok is disabled while active', async () => {
    getSettings.mockResolvedValue({
      imageGen: {
        mode: 'grok',
        local: { pythonPath: '/usr/bin/python3' },
        grok: { enabled: true },
      },
    });
    await renderTab();
    fireEvent.click(screen.getByRole('tab', { name: /Grok CLI/i }));
    fireEvent.click(screen.getByLabelText(/Enable Grok Imagegen/i));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const patch = updateSettings.mock.calls[0][0];
    expect(patch.imageGen.grok.enabled).toBe(false);
    expect(patch.imageGen.mode).toBe('local');
  });
});
