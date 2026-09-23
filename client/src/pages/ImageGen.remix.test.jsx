import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import {
  imageGenModel,
  loadImageGenPage,
  renderImageGenPage,
  resetImageGenMockState,
  state,
} from '../test/imageGenPageMocks.jsx';

const MODEL = imageGenModel('installed-image', { name: 'Example Image Model' });
const LORA = { filename: 'example-style.safetensors', name: 'Example Style' };
const RECORD = {
  filename: 'example-render.png',
  prompt: 'a paper kite above a garden',
  negative_prompt: 'blurry edges',
  modelId: MODEL.id,
  width: 1024,
  height: 768,
  seed: 42,
  steps: 12,
  guidance: 3.5,
  quantize: '6',
  loraFilenames: [LORA.filename],
  loraScales: [0.7],
};

await loadImageGenPage();

describe('ImageGen cross-page Remix handoff', () => {
  beforeEach(() => {
    resetImageGenMockState();
    state.models = [MODEL];
    state.availableLoras = [LORA];
    state.getGalleryImages.mockResolvedValue([RECORD]);
    window.matchMedia = vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  it('restores the same image settings from a filename handoff as in-page Remix', async () => {
    await renderImageGenPage('/media/image?remix=' + encodeURIComponent(RECORD.filename));

    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(RECORD.prompt));
    expect(state.getGalleryImages).toHaveBeenCalledWith([RECORD.filename], { silent: true });
    expect(screen.getByLabelText('Negative Prompt')).toHaveValue(RECORD.negative_prompt);
    expect(screen.getByLabelText('Model')).toHaveValue(MODEL.id);
    expect(screen.getByLabelText('Seed')).toHaveValue(RECORD.seed);
    expect(screen.getByLabelText(/Steps/)).toHaveValue(RECORD.steps);
    expect(screen.getByLabelText(/Guidance/)).toHaveValue(RECORD.guidance);
    expect(screen.getByLabelText('Quantize (bits)')).toHaveValue(RECORD.quantize);
    expect(state.resolutionFieldProps).toMatchObject({ width: RECORD.width, height: RECORD.height });
    expect(state.loraPickerProps.selected).toEqual([
      { filename: LORA.filename, name: LORA.name, scale: RECORD.loraScales[0] },
    ]);
    await waitFor(() => expect(state.locationSearch).not.toContain('remix'));
  });

  it('waits for the model and LoRA catalogs before restoring the form', async () => {
    let settleModels;
    let settleLoras;
    state.listImageModels.mockReturnValue(new Promise((resolve) => { settleModels = resolve; }));
    state.listLorasFull.mockReturnValue(new Promise((resolve) => { settleLoras = resolve; }));
    await renderImageGenPage('/media/image?remix=' + encodeURIComponent(RECORD.filename));

    await screen.findByText(/Restoring this image’s settings/);
    expect(screen.getByLabelText('Prompt')).not.toHaveValue(RECORD.prompt);
    expect(screen.getByRole('button', { name: /Generate/ })).toBeDisabled();

    await act(async () => {
      settleModels([MODEL]);
      settleLoras([LORA]);
    });

    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(RECORD.prompt));
    expect(state.loraPickerProps.selected).toEqual([
      { filename: LORA.filename, name: LORA.name, scale: RECORD.loraScales[0] },
    ]);
  });

  it('does not select a model that is no longer installed', async () => {
    state.getGalleryImages.mockResolvedValue([{ ...RECORD, modelId: 'retired-model' }]);
    await renderImageGenPage('/media/image?remix=' + encodeURIComponent(RECORD.filename));

    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(RECORD.prompt));
    expect(screen.getByLabelText('Model')).toHaveValue(MODEL.id);
  });

  it('keeps the legacy prompt and size URL handoff working', async () => {
    await renderImageGenPage('/media/image?prompt=legacy%20prompt&width=704&height=1280');

    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue('legacy prompt'));
    expect(state.resolutionFieldProps).toMatchObject({ width: 704, height: 1280 });
    await waitFor(() => expect(state.locationSearch).toBe(''));
    expect(state.getGalleryImages).not.toHaveBeenCalled();
  });

  it('keeps the legacy Send-to-i2i init image handoff working', async () => {
    await renderImageGenPage('/media/image?initImageFile=example-source.png');

    await waitFor(() => expect(state.initImagePickerProps?.initImage).toMatchObject({
      source: 'gallery',
      name: 'example-source.png',
      previewUrl: '/data/images/example-source.png',
    }));
    await waitFor(() => expect(state.locationSearch).toBe(''));
    expect(state.getGalleryImages).not.toHaveBeenCalled();
  });

  it('shows a retryable notice for a missing image and removes the handoff URL', async () => {
    state.getGalleryImages.mockResolvedValueOnce([]).mockResolvedValueOnce([RECORD]);
    await renderImageGenPage('/media/image?remix=' + encodeURIComponent(RECORD.filename));

    await screen.findByText(/no longer in the gallery/);
    await waitFor(() => expect(state.locationSearch).not.toContain('remix'));

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(RECORD.prompt));
    expect(state.getGalleryImages).toHaveBeenCalledTimes(2);
  });

  it('shows a dismissible notice when the lookup fails and removes the handoff URL', async () => {
    state.getGalleryImages.mockRejectedValueOnce(new Error('offline'));
    await renderImageGenPage('/media/image?remix=' + encodeURIComponent(RECORD.filename));

    await screen.findByText(/load this image’s render settings/);
    await waitFor(() => expect(state.locationSearch).not.toContain('remix'));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText(/load this image’s render settings/)).toBeNull());
  });
});
