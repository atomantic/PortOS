import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/api', () => ({
  getSettings: vi.fn(),
  patchSettingsSlice: vi.fn(),
  getImageGenStatus: vi.fn(),
  getVideoGenModelContext: vi.fn(),
  generateImage: vi.fn(),
  registerTool: vi.fn(),
  updateTool: vi.fn(),
  getToolsList: vi.fn(),
  saveHfToken: vi.fn(),
  clearHfToken: vi.fn(),
  getCredentialInventory: vi.fn(),
  saveCredential: vi.fn(),
  listAgyImageModels: vi.fn(),
  listImageModels: vi.fn(),
  getProviders: vi.fn(),
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
// The runtime card's install modal opens its own SSE stream.
vi.mock('../imageGen/Flux2InstallModal', () => ({ default: () => null }));

import {
  getSettings, getToolsList, patchSettingsSlice, listAgyImageModels, listImageModels, getImageGenStatus,
  getVideoGenModelContext, generateImage, getCredentialInventory, getProviders, registerTool, updateTool,
} from '../../services/api';
import { useHfTokenStatus } from '../../hooks/useHfTokenStatus';
import { ImageGenTab, MEDIA_TABS } from './ImageGenTab';
import { IMAGE_GEN_MODE } from '../../lib/imageGenBackends';

// Every slice PATCH a save sent, keyed by slice path.
const sentSlices = () => Object.fromEntries(patchSettingsSlice.mock.calls.map(([slicePath, partial]) => [slicePath, partial]));
const awaitSave = () => waitFor(() => expect(patchSettingsSlice).toHaveBeenCalled());

const renderTab = async (initialEntries = ['/media/image']) => {
  const view = render(
    <MemoryRouter initialEntries={initialEntries}>
      <ImageGenTab />
    </MemoryRouter>,
  );
  // Cards render only after the settings fetch resolves.
  await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy());
  return view;
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
  registerTool.mockResolvedValue({});
  updateTool.mockResolvedValue({});
  getImageGenStatus.mockResolvedValue({ connected: true, mode: 'local', readiness: 'ready', model: 'FLUX.1 Dev', modelId: 'dev' });
  getVideoGenModelContext.mockResolvedValue({
    models: [
      { id: 'fastmetal_5b_qad', name: 'FastMetal 5B QAD' },
      { id: 'ltx23_distilled_q4', name: 'LTX-2.3 Distilled Q4' },
    ],
    defaultModel: 'fastmetal_5b_qad',
  });
  useHfTokenStatus.mockReturnValue({ present: false, source: 'none', refresh: vi.fn() });
  getCredentialInventory.mockResolvedValue({
    headline: '', credentials: [
      { id: 'fal', label: 'fal.ai', configured: false, source: 'none', editable: true },
      { id: 'reactor', label: 'reactor.inc', configured: false, source: 'none', editable: true },
    ],
  });
  patchSettingsSlice.mockResolvedValue({});
  getProviders.mockResolvedValue({
    providers: [{ id: 'codex', type: 'cli', command: 'codex', models: ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-luna'] }],
  });
  listAgyImageModels.mockResolvedValue({ models: ['gemini-image', 'custom/image-v2'], error: null });
  listImageModels.mockResolvedValue([
    { id: 'dev', name: 'FLUX.1 Dev' },
    { id: 'qwen-image-2.1', name: 'Qwen-Image 2.1' },
    { id: 'flux2-klein-4b', name: 'FLUX.2 Klein' },
  ]);
});

describe('ImageGenTab grouped tabs', () => {
  it.each(['settings', 'tools'])('shows a retryable %s load failure before offering editable defaults', async (failedRead) => {
    const read = failedRead === 'settings' ? getSettings : getToolsList;
    read.mockRejectedValueOnce(new Error('offline'));
    render(<MemoryRouter><ImageGenTab /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy());
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /External/i }));
    expect(screen.getByPlaceholderText('http://localhost:7860').value).toBe('http://localhost:7860');
  });

  // Catches persisting a second key or dropping Runway's enable/model/resolution slice.
  it('configures Runway images with the shared credential and persists its own rendering settings', async () => {
    await renderTab(['/media/image?mediaTab=runway']);
    expect(screen.getByRole('heading', { name: 'Runway Imagegen' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings → Credentials' }).getAttribute('href')).toBe('/settings/credentials');
    expect(screen.queryByPlaceholderText('key_...')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Runway Imagegen' }));
    fireEvent.change(screen.getByLabelText('Default model'), { target: { value: 'gen4_image_turbo' } });
    fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '1080p' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchSettingsSlice).toHaveBeenCalledWith('imageGen.runway', expect.objectContaining({ enabled: true, model: 'gen4_image_turbo', resolution: '1080p' }), expect.anything()));
  });

  it.each([undefined, { min: 1, max: Number.MAX_SAFE_INTEGER, default: 1 }])(
    'loads and saves render limits above ten with bounds %j', async (parallelLimitBounds) => {
      getSettings.mockResolvedValue({
        imageGen: {
          mode: 'codex', codex: { enabled: true, parallelLimit: 25, parallelLimitBounds },
        },
      });
      await renderTab(['/media/image?mediaTab=codex']);
      // The Codex section's model list loads late (getProviders). Wait for it to
      // land so its state update happens inside the waitFor, not after the edit.
      await waitFor(() => expect(screen.getByRole('option', { name: 'gpt-5.6-luna' })).toBeTruthy());
      const input = screen.getByLabelText('Parallel render limit');
      expect(input.value).toBe('25');
      fireEvent.change(input, { target: { value: '50' } });
      fireEvent.blur(input);
      expect(input.value).toBe('50');
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await awaitSave();
      expect(sentSlices()['imageGen.codex'].parallelLimit).toBe(50);
    },
  );

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
    expect(screen.getByText('Local models')).toBeTruthy();
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
    // The tab's lazy model-catalog probe resolves after the click.
    await act(async () => {});
  });

  it.each([
    ['moss-image-sft-bf16', true],
    ['schnell', false],
  ])('offers a Python-free local test backend only for the native model pin %s', async (modelId, available) => {
    getSettings.mockResolvedValue({ imageGen: {
      mode: 'external', external: { sdapiUrl: 'http://localhost:7860' }, local: { modelId },
    } });
    await renderTab(['/media/image?mediaTab=test']);
    const options = [...screen.getByLabelText('Backend').options].map(option => option.value);
    expect(options.includes('local')).toBe(available);
  });

  it('registers the local image tool for a MOSS pin without a Python interpreter', async () => {
    getSettings.mockResolvedValue({ imageGen: {
      mode: 'external', external: { sdapiUrl: 'http://localhost:7860' }, local: { modelId: 'moss-image-sft-bf16' },
    } });
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: /Local models/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({
      id: 'sdapi', enabled: true, config: expect.objectContaining({ mode: 'local', pythonPath: '' }),
    }), { silent: true }));
  });

  it('lets the user set a default local video model separately from the backend target', async () => {
    await renderTab(['/media/image?mediaTab=local']);
    await act(async () => {});

    const select = screen.getByLabelText('Default local video model');
    expect(select.value).toBe('');
    expect(screen.getByRole('option', { name: 'Install default (FastMetal 5B QAD)' })).toBeTruthy();
    fireEvent.change(select, { target: { value: 'ltx23_distilled_q4' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await awaitSave();

    expect(sentSlices().videoGen).toEqual({ defaultModelId: 'ltx23_distilled_q4' });
  });

  it('clears the saved local video model pin to follow the install default', async () => {
    getSettings.mockResolvedValue({
      imageGen: { mode: 'external', external: { sdapiUrl: 'http://localhost:7860' } },
      videoGen: { defaultModelId: 'ltx23_distilled_q4' },
    });
    await renderTab(['/media/image?mediaTab=local']);
    await act(async () => {});

    fireEvent.change(screen.getByLabelText('Default local video model'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await awaitSave();

    expect(sentSlices().videoGen).toEqual({ defaultModelId: null });
  });

  it('keeps LocalSetupPanel mounted (hidden) after leaving the Local tab so an in-flight install stream is not torn down', async () => {
    await renderTab();
    // Not mounted until first visited (avoids a cold python-env probe).
    expect(screen.queryByTestId('local-setup-panel')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /^Local/i }));
    await act(async () => {});
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

  it('saves only the changed fields as slice patches, so a sibling panel\'s later write survives (#12030)', async () => {
    // The drawer loaded pythonPath '/usr/bin/python3'. While it is open,
    // VideoGen's LocalSetupPanel patches imageGen.local.pythonPath to a new
    // interpreter — a write this drawer cannot see. Its save must not carry
    // a snapshot of imageGen.local (or of any slice the user did not edit).
    await renderTab();
    fireEvent.click(screen.getByRole('tab', { name: /External/i }));
    const urlInput = screen.getByPlaceholderText('http://localhost:7860');
    fireEvent.change(urlInput, { target: { value: 'http://localhost:9999' } });
    const saveBtn = screen.getByRole('button', { name: /^Save$/ });
    expect(saveBtn.disabled).toBe(false);
    fireEvent.click(saveBtn);
    await awaitSave();
    // The legacy flat `imageGen.sdapiUrl` is kept populated beside the
    // external slice; nothing else travels.
    expect(sentSlices()).toEqual({
      'imageGen.external': { sdapiUrl: 'http://localhost:9999' },
      imageGen: { sdapiUrl: 'http://localhost:9999' },
    });
    expect(patchSettingsSlice.mock.calls.every(([, , options]) => options?.silent === true)).toBe(true);
    await waitFor(() => expect(saveBtn.disabled).toBe(true));
  });

  it('preserves edits made during a pending save and sends them on the next save', async () => {
    let finishPatch;
    patchSettingsSlice.mockImplementationOnce(() => new Promise(resolve => { finishPatch = resolve; }));
    await renderTab(['/media/image?mediaTab=external']);
    const input = screen.getByPlaceholderText('http://localhost:7860');
    const save = screen.getByRole('button', { name: /^Save$/ });
    fireEvent.change(input, { target: { value: 'http://example.test:9001/' } });
    fireEvent.click(save);
    await awaitSave();
    fireEvent.change(input, { target: { value: 'http://example.test:9002/' } });
    await act(async () => { finishPatch({}); });
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(input.value).toBe('http://example.test:9002/');
    expect(screen.getByRole('button', { name: /Test Connection/ }).disabled).toBe(true);

    patchSettingsSlice.mockClear();
    fireEvent.click(save);
    await waitFor(() => expect(save.disabled).toBe(true));
    expect(sentSlices()['imageGen.external']).toEqual({ sdapiUrl: 'http://example.test:9002' });
    expect(input.value).toBe('http://example.test:9002');
  });

  it('keeps the form dirty and re-sends the same patches when a slice save fails', async () => {
    patchSettingsSlice.mockRejectedValueOnce(new Error('offline'));
    await renderTab();
    fireEvent.click(screen.getByRole('tab', { name: /External/i }));
    fireEvent.change(screen.getByPlaceholderText('http://localhost:7860'), { target: { value: 'http://localhost:9999' } });
    const saveBtn = screen.getByRole('button', { name: /^Save$/ });
    fireEvent.click(saveBtn);
    await awaitSave();
    await waitFor(() => expect(saveBtn.disabled).toBe(false));
    patchSettingsSlice.mockClear();
    fireEvent.click(saveBtn);
    await awaitSave();
    expect(sentSlices()['imageGen.external']).toEqual({ sdapiUrl: 'http://localhost:9999' });
  });

  it('offers the Codex provider\'s models in a picker and keeps an unlisted stored pin', async () => {
    getSettings.mockResolvedValue({
      imageGen: { mode: 'codex', codex: { enabled: true, model: 'gpt-retired' }, expose: { a1111: false } },
    });
    await renderTab(['/media/image?mediaTab=codex']);
    const select = await screen.findByLabelText('Model override (optional)');
    await waitFor(() => expect(screen.getByRole('option', { name: 'gpt-6-sol' })).toBeTruthy());
    // A stored model the catalog no longer lists stays selected rather than
    // rendering blank and being dropped on the next save.
    expect(select.value).toBe('gpt-retired');
    expect(screen.getByRole('option', { name: /^Default \(gpt-6-luna\)/ })).toBeTruthy();

    fireEvent.change(select, { target: { value: 'gpt-6-sol' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await awaitSave();
    expect(sentSlices()['imageGen.codex']).toEqual({ model: 'gpt-6-sol' });
  });

  it('shows a retryable error, not a bare default-only picker, when the Codex provider read fails', async () => {
    getSettings.mockResolvedValue({
      imageGen: { mode: 'codex', codex: { enabled: true }, expose: { a1111: false } },
    });
    getProviders.mockRejectedValueOnce(new Error('providers down'));
    await renderTab(['/media/image?mediaTab=codex']);

    expect(await screen.findByText(/Could not load your Codex provider's models/)).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'gpt-6-sol' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: 'gpt-6-sol' })).toBeTruthy();
    expect(screen.queryByText(/Could not load your Codex provider's models/)).toBeNull();
  });

  it('pins the install-wide default local model and saves it under imageGen.local.modelId', async () => {
    await renderTab(['/media/image?mediaTab=local']);
    await act(async () => {});
    const select = screen.getByLabelText('Default model');
    // Nothing pinned in settings — blank names what the server actually
    // resolves to, not an empty option the user has to guess at.
    expect(select.value).toBe('');
    expect(screen.getByRole('option', { name: 'Install default (Qwen-Image 2.1)' })).toBeTruthy();

    fireEvent.change(select, { target: { value: 'flux2-klein-4b' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await awaitSave();
    expect(sentSlices()['imageGen.local']).toEqual({ modelId: 'flux2-klein-4b' });
  });

  it('clears modelId with an explicit null when the pin is cleared, so the server default resolves again', async () => {
    getSettings.mockResolvedValue({
      imageGen: {
        mode: 'local',
        external: { sdapiUrl: '' },
        local: { pythonPath: '/usr/bin/python3', modelId: 'flux2-klein-4b' },
        codex: { enabled: false },
        expose: { a1111: false },
      },
    });
    await renderTab(['/media/image?mediaTab=local']);
    await act(async () => {});
    const select = screen.getByLabelText('Default model');
    expect(select.value).toBe('flux2-klein-4b');

    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await awaitSave();
    // null, not '' — the slice merge keeps an omitted key, so the clear must
    // be a value; every consumer reads `local.modelId || DEFAULT`, and a
    // persisted empty string is a value they would all have to keep coercing.
    expect(sentSlices()['imageGen.local']).toEqual({ modelId: null });
  });

  it('keeps a pin the catalog no longer lists selectable rather than silently dropping it', async () => {
    getSettings.mockResolvedValue({
      imageGen: {
        mode: 'local',
        external: { sdapiUrl: '' },
        local: { pythonPath: '/usr/bin/python3', modelId: 'retired-model' },
        codex: { enabled: false },
        expose: { a1111: false },
      },
    });
    await renderTab(['/media/image?mediaTab=local']);
    await act(async () => {});
    // A select whose value matches no option paints blank and reads as
    // "install default" — while the server is still honouring the pin.
    expect(screen.getByLabelText('Default model').value).toBe('retired-model');
    expect(screen.getByRole('option', { name: /retired-model \(unavailable on this machine\)/ })).toBeTruthy();
  });

  it('the imageGen.local save body names only the changed field, so hand-edited siblings survive', async () => {
    // imageGen.local carries hand-edit-only render knobs this tab never
    // renders (steps / guidance / quantize, read by fableLoom/production.js).
    // The slice PATCH merges per field, so the drawer neither re-sends a
    // snapshot of them nor omits them into oblivion.
    getSettings.mockResolvedValue({
      imageGen: {
        mode: 'local',
        external: { sdapiUrl: '' },
        local: { pythonPath: '/usr/bin/python3', steps: 28, guidance: 4.5, quantize: '4' },
        codex: { enabled: false },
        expose: { a1111: false },
      },
    });
    await renderTab(['/media/image?mediaTab=local']);
    await act(async () => {});

    fireEvent.change(screen.getByLabelText('Default model'), { target: { value: 'flux2-klein-4b' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await awaitSave();
    expect(sentSlices()).toEqual({ 'imageGen.local': { modelId: 'flux2-klein-4b' } });
  });

  it('the videoGen save body carries only the changed pin (#3231 Phase 4)', async () => {
    // A Defaults-tab save that re-sent the loaded slice would overwrite a
    // videoGen.defaultModelId another surface changed after this drawer
    // opened. The exact wire body is pinned HERE.
    getSettings.mockResolvedValue({
      imageGen: { mode: 'external', external: { sdapiUrl: 'http://localhost:7860' } },
      videoGen: { mode: 'grok', defaultModelId: 'ltx23_distilled_q4' },
    });
    await renderTab(['/media/image?mediaTab=defaults']);
    const videoSelect = screen.getByLabelText(/Default video backend/i);
    expect(videoSelect.value).toBe('grok');
    fireEvent.change(videoSelect, { target: { value: 'local' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await awaitSave();
    // fal/reactor keys are no longer part of this save body (#8997) — they
    // move through the write-only credential setter instead.
    expect(sentSlices()).toEqual({ videoGen: { mode: 'local' } });
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

  it('opens no render stream when the tab unmounts before the test render is acknowledged', async () => {
    getSettings.mockResolvedValue(multiBackendSettings);
    let acknowledge;
    generateImage.mockReturnValue(new Promise((resolve) => { acknowledge = resolve; }));
    const OriginalEventSource = globalThis.EventSource;
    const streams = [];
    globalThis.EventSource = function EventSourceStub(url) { streams.push(url); this.close = vi.fn(); };
    try {
      const view = await renderTab(['/media/image?mediaTab=test']);
      fireEvent.click(screen.getByRole('button', { name: /Render Test Image/i }));
      await waitFor(() => expect(generateImage).toHaveBeenCalled());
      view.unmount();
      await act(async () => { acknowledge({ mode: 'local', generationId: 'job-durable' }); });
      expect(streams).toEqual([]);
    } finally {
      globalThis.EventSource = OriginalEventSource;
    }
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
    await awaitSave();

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
    await awaitSave();
    expect(sentSlices()).toEqual({ 'imageGen.agy': { model: 'custom/image-v3' } });
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
    await awaitSave();
    // The wire body carries exactly the changed target — the untouched
    // universe-bible pin is not re-sent, and no 'auto' no-ops travel.
    expect(sentSlices()).toEqual({
      renderDefaults: { 'sprite-reference': { imageMode: 'agy', imageModel: 'gemini-3.6-flash-low' } },
    });
  });

  it('clears a render-default pin with an explicit null entry (#12030)', async () => {
    getSettings.mockResolvedValue({
      imageGen: { mode: 'local' },
      renderDefaults: { 'universe-bible': { imageMode: 'codex' } },
    });
    await renderTab(['/media/image?mediaTab=defaults']);
    const bibleSelect = await screen.findByLabelText('Universe Bible & canon renders');
    fireEvent.change(bibleSelect, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await awaitSave();
    expect(sentSlices()).toEqual({ renderDefaults: { 'universe-bible': null } });
  });

  it('grok pins never show a model input — its backend has no model knob (#3231)', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'local' } });
    await renderTab(['/media/image?mediaTab=defaults']);
    const select = await screen.findByLabelText('Sprite references & anchors');
    fireEvent.change(select, { target: { value: 'grok' } });
    expect(screen.queryByLabelText('Sprite references & anchors model')).toBeNull();
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
    await awaitSave();
    expect(sentSlices()).toEqual({ 'imageGen.grok': { grokPath: '/usr/local/bin/grok' } });
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
    await awaitSave();
    expect(sentSlices()).toEqual({ imageGen: { mode: 'local' }, 'imageGen.grok': { enabled: false } });
  });
});

describe('ImageGenTab — fal.ai section', () => {
  it('points at the shared fal.ai key when none is configured', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('tab', { name: /fal\.ai/i }));
    expect(await screen.findByText(/No fal\.ai API key — set it under the Defaults tab/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open Defaults/i }));
    expect(screen.getByRole('tab', { name: /Defaults/i }).getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('fal-api-key')).toBeTruthy();
  });

  it('saves the enable toggle and a catalog model under imageGen.fal, and adds a backend tile', async () => {
    getCredentialInventory.mockResolvedValue({
      headline: '', credentials: [{ id: 'fal', label: 'fal.ai', configured: true, source: 'settings', editable: true }],
    });
    await renderTab();
    fireEvent.click(screen.getByRole('tab', { name: /fal\.ai/i }));
    expect(await screen.findByText(/fal\.ai API key configured/i)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Enable fal\.ai Imagegen/i));
    fireEvent.change(screen.getByLabelText(/Default model/i), { target: { value: 'fal-ai/bytedance/seedream/v5/lite/text-to-image' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await awaitSave();
    expect(sentSlices()['imageGen.fal']).toEqual({
      enabled: true, model: 'fal-ai/bytedance/seedream/v5/lite/text-to-image',
    });
    fireEvent.click(screen.getByRole('tab', { name: /Backend/i }));
    expect(screen.getByText(/Hosted image and reference-edit models through fal\.ai/i)).toBeTruthy();
  });
});

// The packages panel above the card only ever probes the mflux interpreter, so
// on its own it told a machine whose selected default renders through the
// shared torch venv that everything was installed — while the Image Gen page
// two clicks away called the same machine unavailable.
describe('ImageGenTab local runtime card', () => {
  const brokenTorchRuntime = {
    readiness: 'unavailable', modelId: 'flux2-klein-4b', model: 'FLUX.2 Klein',
    runtimeLabel: 'Shared torch runtime (FLUX.2 · Z-Image · ERNIE · HiDream · Qwen)',
    reason: 'The shared torch image runtime is not installed or healthy (expected at /home/u/.portos/venv-flux2/bin/python3)',
    remedy: { kind: 'install-torch-venv', label: 'Install runtime', venvPath: '/home/u/.portos/venv-flux2/bin/python3' },
  };

  it('reports the shared torch runtime the pinned model actually needs', async () => {
    getImageGenStatus.mockResolvedValue(brokenTorchRuntime);
    await renderTab();
    fireEvent.click(screen.getByRole('tab', { name: /^Local/i }));

    expect(await screen.findByText(/not installed or healthy/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /install runtime/i })).toBeInTheDocument();
  });

  it('probes the runtime for the model the tab has pinned, not the install default', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('tab', { name: /^Local/i }));
    await waitFor(() => expect(getImageGenStatus).toHaveBeenCalledWith('local', 'qwen-image-2.1', expect.anything()));

    fireEvent.change(screen.getByLabelText('Default model'), { target: { value: 'flux2-klein-4b' } });
    await waitFor(() => expect(getImageGenStatus).toHaveBeenCalledWith('local', 'flux2-klein-4b', expect.anything()));
  });
});

vi.mock('../../services/apiRunwayCatalog.js', async (importOriginal) => ({ ...await importOriginal(), loadRunwayCatalog: vi.fn().mockResolvedValue(undefined) }));

it('hides the retired training default and leaves its saved pin untouched while editing a supported surface', async () => {
  getSettings.mockResolvedValue({ imageGen: { mode: 'local' }, renderDefaults: { 'lora-dataset': { imageMode: 'grok' } } });
  await renderTab(['/media/image?mediaTab=defaults']);
  const live = await screen.findByLabelText('Universe Bible & canon renders');
  expect(screen.queryByLabelText('LoRA training datasets')).toBeNull();
  fireEvent.change(live, { target: { value: 'grok' } });
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await awaitSave();
  expect(sentSlices()).toEqual({ renderDefaults: { 'universe-bible': { imageMode: 'grok' } } });
});
