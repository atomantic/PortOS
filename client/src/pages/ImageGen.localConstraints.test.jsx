import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  imageGenModel,
  loadImageGenPage,
  renderImageGenPage,
  resetImageGenMockState,
  state,
} from '../test/imageGenPageMocks.jsx';

await loadImageGenPage();

const openModel = imageGenModel('dev');
const restrictedInputs = { supportsLoras: false, supportsImg2Img: false, supportsNegativePrompt: false, cfgDisabled: true };
const flux3 = imageGenModel('flux3-klein-q4', { ...restrictedInputs, runner: 'flux3' });
const minimax = imageGenModel('minimax-h3-image', {
  ...restrictedInputs, runner: 'minimax-h3-image', steps: 6, samplerLocked: true, maxReferenceImages: 16,
});
const lora = { filename: 'example-style.safetensors', name: 'Example Style' };
const prompt = 'A lighthouse at dusk';

describe('Image Gen local model constraints', () => {
  beforeEach(() => {
    resetImageGenMockState();
    state.models = [openModel, flux3, minimax];
  });

  afterEach(() => vi.useRealTimers());

  async function expectBlockedRender(button) {
    expect(button).toBeDisabled();
    state.previewImagePrompt.mockClear();
    await act(async () => {
      fireEvent.submit(button.form);
      vi.advanceTimersByTime(600);
    });
    expect(state.generateImage).not.toHaveBeenCalled();
    expect(state.generateImageMultipart).not.toHaveBeenCalled();
    expect(state.previewImagePrompt).not.toHaveBeenCalled();
  }

  const unsupportedInputs = [
    { name: 'negative prompt', record: { negative_prompt: 'fog' }, clear: () => fireEvent.change(screen.getByLabelText('Negative Prompt'), { target: { value: '' } }) },
    { name: 'LoRA', record: { loraFilenames: [lora.filename] }, clear: () => fireEvent.click(screen.getByRole('button', { name: 'Remove selected LoRAs' })) },
    { name: 'init image', record: { initImageFilename: 'source.png' }, clear: () => fireEvent.click(screen.getByRole('button', { name: 'Remove input image' })) },
  ];

  const unsupportedCases = [flux3, minimax].flatMap((model) => unsupportedInputs.map((input) => ({ model, ...input })));

  it.each(unsupportedCases)('blocks $name for $model.id and resumes after clearing it', async ({ model, record, clear }) => {
    state.availableLoras = [lora];
    state.getGalleryImages.mockResolvedValue([{
      filename: 'remix.png', prompt, modelId: openModel.id, ...record,
    }]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) })));
    try {
      await renderImageGenPage('/media/image?remix=remix.png');
      await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(prompt));
      await waitFor(() => expect(state.locationSearch).toBe(''));
      const button = screen.getByRole('button', { name: 'Generate' });
      expect(button).toBeEnabled();

      vi.useFakeTimers();
      fireEvent.change(screen.getByLabelText('Model'), { target: { value: model.id } });
      await act(async () => {});
      await expectBlockedRender(button);
      clear();
      expect(button).toBeEnabled();
      await act(async () => { vi.advanceTimersByTime(600); });
      expect(state.previewImagePrompt).toHaveBeenCalledWith(expect.objectContaining({ modelId: model.id, prompt }), { silent: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('blocks a negative prompt supplied by the selected universe style', async () => {
    await renderImageGenPage(`/media/image?modelId=${flux3.id}&prompt=lighthouse`);
    vi.useFakeTimers();
    const button = screen.getByRole('button', { name: 'Generate' });
    expect(button).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Use universe style' }));
    await expectBlockedRender(button);
    expect(button.title).toMatch(/universe style/);
  });

  it('blocks an invalid FLUX.3 custom size and resumes after correction', async () => {
    await renderImageGenPage(`/media/image?modelId=${flux3.id}&width=705&height=1280&prompt=lighthouse`);
    vi.useFakeTimers();
    const button = screen.getByRole('button', { name: 'Generate' });
    await expectBlockedRender(button);
    expect(button.title).toMatch(/supported width and height/);

    act(() => { state.resolutionFieldProps.onChange(704, 1024); });
    expect(button).toBeEnabled();
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(state.previewImagePrompt).toHaveBeenCalledWith(expect.objectContaining({ width: 704, height: 1024 }), { silent: true });
  });

  it.each([flux3, minimax])('only sends remixed steps if the $id sampler is adjustable', async (model) => {
    state.getGalleryImages.mockResolvedValue([{ filename: 'remix.png', modelId: model.id, prompt, steps: 12 }]);
    await renderImageGenPage('/media/image?remix=remix.png');
    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(prompt));
    expect(Boolean(screen.queryByLabelText(/Steps/))).toBe(!model.samplerLocked);
    await waitFor(() => expect(state.previewImagePrompt).toHaveBeenCalledWith(expect.objectContaining({ modelId: model.id, prompt }), { silent: true }));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Generate' })); });
    expect(state.generateImage).toHaveBeenCalledWith(expect.objectContaining({ modelId: model.id, prompt }), { silent: true });
    for (const payload of [state.previewImagePrompt.mock.calls.at(-1)[0], state.generateImage.mock.calls[0][0]]) {
      if (model.samplerLocked) expect(payload).not.toHaveProperty('steps');
      else expect(payload.steps).toBe(12);
    }
  });
});
