import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import {
  imageGenModel,
  loadImageGenPage,
  renderImageGenPage,
  resetImageGenMockState,
  state,
} from '../test/imageGenPageMocks.jsx';

const { default: LoraPicker } = await vi.importActual('../components/imageGen/LoraPicker.jsx');
await loadImageGenPage();

const DEV = imageGenModel('dev');
const FOUR = imageGenModel('flux2-klein-4b', { runner: 'flux2' });
const NINE = imageGenModel('flux2-klein-9b', { runner: 'flux2' });
const OTHER_NINE = imageGenModel('flux2-base-9b', { runner: 'flux2' });
const LORA = {
  filename: 'example-style.safetensors', name: 'Example Style',
  runnerFamily: 'flux2', loraCompatKey: 'flux2-9b',
  recommendedScale: 0.7, triggerWords: ['example-style', 'paper texture'],
};
const SETTINGS = {
  imageGen: {
    mode: 'codex', codex: { enabled: true },
    local: { pythonPath: '/usr/bin/python3', modelId: FOUR.id },
  },
};
const LINK = '/media/image?lora=' + encodeURIComponent(LORA.filename);
const generate = () => screen.getByRole('button', { name: 'Generate' });
const deferred = () => {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
};

describe('ImageGen image LoRA Test handoff', () => {
  beforeEach(() => {
    resetImageGenMockState();
    state.models = [DEV, FOUR, NINE, OTHER_NINE];
    state.availableLoras = [LORA];
    state.settings = SETTINGS;
    state.loraPickerFactory = LoraPicker;
    state.getImageGenStatus.mockImplementation(async (mode) => ({
      connected: true, readiness: 'ready', mode,
    }));
    window.matchMedia = vi.fn(() => ({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
  });

  // These orders catch the saved cloud default overwriting the explicit Test
  // intent, and the adapter being consumed before a compatible model arrives.
  it.each(['settings-first', 'catalogs-first'])('resolves %s to a visible adapter and submits its filename/scale', async (order) => {
    const settings = deferred();
    const models = deferred();
    const loras = deferred();
    state.getSettings.mockReturnValue(settings.promise);
    state.listImageModels.mockReturnValue(models.promise);
    state.listLorasFull.mockReturnValue(loras.promise);
    await renderImageGenPage(LINK, { strict: true });
    expect(generate()).toBeDisabled();
    expect(state.locationSearch).toContain('lora=');
    await act(async () => {
      if (order === 'settings-first') settings.resolve(SETTINGS);
      else loras.resolve([LORA]);
    });
    expect(generate()).toBeDisabled();
    await act(async () => {
      models.resolve(state.models);
      loras.resolve([LORA]);
      settings.resolve(SETTINGS);
    });
    await waitFor(() => expect(generate()).toBeEnabled());
    expect(screen.getByLabelText('Model')).toHaveValue(NINE.id);
    expect(screen.getByRole('checkbox', { name: /Example Style/ })).toBeChecked();
    expect(screen.getByLabelText('Scale for ' + LORA.filename)).toHaveValue(0.7);
    expect(screen.getByText('Options').closest('details')).toHaveAttribute('open');
    expect(screen.getByLabelText('Prompt')).toHaveValue('example-style, paper texture');
    expect(state.locationSearch).toBe('');
    expect(SETTINGS.imageGen.mode).toBe('codex');
    fireEvent.click(generate());
    await waitFor(() => expect(state.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'local', modelId: NINE.id,
        loraFilenames: [LORA.filename], loraScales: [0.7],
      }), { silent: true },
    ));
  });

  it('keeps a compatible explicitly selected model instead of the first match', async () => {
    await renderImageGenPage(LINK + '&modelId=' + OTHER_NINE.id);
    await waitFor(() => expect(generate()).toBeEnabled());
    expect(screen.getByLabelText('Model')).toHaveValue(OTHER_NINE.id);
  });

  it('skips an unavailable compatible runtime and resolves the next ready model', async () => {
    state.getImageGenStatus.mockImplementation(async (mode, modelId) => ({
      connected: modelId !== NINE.id, readiness: modelId === NINE.id ? 'unavailable' : 'ready', mode,
    }));
    await renderImageGenPage(LINK);
    await waitFor(() => expect(generate()).toBeEnabled());
    expect(screen.getByLabelText('Model')).toHaveValue(OTHER_NINE.id);
  });

  it.each([
    ['missing adapter', () => { state.availableLoras = []; }, /no longer installed/],
    ['disabled local backend', () => { state.settings = { imageGen: { mode: 'codex', codex: { enabled: true } } }; }, /Configure one in Settings/],
    ['incompatible models', () => { state.models = [DEV, FOUR]; }, /No compatible local image runtime/],
    ['unavailable runtime', () => { state.getImageGenStatus.mockResolvedValue({ connected: false, readiness: 'unavailable' }); }, /No compatible local image runtime/],
    ['failed catalog', () => { state.listLorasFull.mockRejectedValue(new Error('offline')); }, /Reload this page to retry/],
  ])('blocks a %s rather than submitting through the cloud', async (_name, setup, message) => {
    setup();
    await renderImageGenPage(LINK + '&prompt=example');
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(generate()).toBeDisabled();
    // The submit boundary must also refuse an implicit/programmatic submit.
    fireEvent.submit(generate().closest('form'));
    expect(state.generateImage).not.toHaveBeenCalled();
    expect(state.locationSearch).toContain('lora=');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel LoRA test' }));
    await waitFor(() => expect(state.locationSearch).not.toContain('lora='));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('blocks cloud fallback after a resolved Test when the backend is changed', async () => {
    await renderImageGenPage(LINK);
    await waitFor(() => expect(generate()).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/compatible local model/);
    expect(generate()).toBeDisabled();
    fireEvent.submit(generate().closest('form'));
    expect(state.generateImage).not.toHaveBeenCalled();
  });

  it('does not revive a cancelled test when its runtime probe arrives late', async () => {
    const probe = deferred();
    state.getImageGenStatus.mockImplementation(async (mode, modelId) => modelId === NINE.id
      ? probe.promise : { connected: true, readiness: 'ready', mode });
    await renderImageGenPage(LINK);
    await waitFor(() => expect(state.getImageGenStatus).toHaveBeenCalledWith('local', NINE.id));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel LoRA test' }));
    await act(async () => { probe.resolve({ connected: true, readiness: 'ready', mode: 'local' }); });
    expect(screen.queryByLabelText('Model')).toBeNull();
    expect(screen.getByLabelText('Prompt')).toHaveValue('');
    expect(state.locationSearch).toBe('');
    expect(state.loraPickerProps).toBeNull();
  });

  it('honors the saved cloud backend on an ordinary visit', async () => {
    await renderImageGenPage('/media/image?prompt=example');
    await waitFor(() => expect(generate()).toBeEnabled());
    expect(screen.queryByLabelText('Model')).toBeNull();
    fireEvent.click(generate());
    await waitFor(() => expect(state.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'codex', prompt: 'example' }), { silent: true },
    ));
  });
});
