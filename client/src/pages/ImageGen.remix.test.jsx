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

  it('clears prompt, negative prompt, and LoRAs missing from a later in-page Remix', async () => {
    const plainImage = { filename: 'plain-image.png', width: 512, height: 512 };
    state.listImageGalleryPage.mockResolvedValue({ items: [RECORD, plainImage], total: 2, offset: 0, limit: 20 });
    state.mediaCardFactory = ({ item, onRemix }) => (
      <button type="button" onClick={() => onRemix(item)}>Remix {item.filename}</button>
    );
    await renderImageGenPage();

    fireEvent.click(await screen.findByRole('button', { name: `Remix ${RECORD.filename}` }));
    await waitFor(() => expect(state.loraPickerProps.selected).toHaveLength(1));
    expect(screen.getByLabelText('Prompt')).toHaveValue(RECORD.prompt);
    expect(screen.getByLabelText('Negative Prompt')).toHaveValue(RECORD.negative_prompt);

    fireEvent.click(screen.getByRole('button', { name: `Remix ${plainImage.filename}` }));

    expect(screen.getByLabelText('Prompt')).toHaveValue('');
    expect(screen.getByLabelText('Negative Prompt')).toHaveValue('');
    expect(state.loraPickerProps.selected).toEqual([]);
  });

  it('restores the init and reference images the render used', async () => {
    const flux2 = imageGenModel('flux2-example', { name: 'Example FLUX.2', runner: 'flux2' });
    state.models = [flux2];
    state.getGalleryImages.mockResolvedValue([{
      ...RECORD,
      modelId: flux2.id,
      initImageFilename: 'init-0a1b.png',
      initImageStrength: 0.65,
      referenceImageFilenames: ['example-ref.png', 'ref-2c3d.png'],
      referenceImageStrengths: [0.5, 0.8],
    }]);
    // The gallery holds the named reference; staged uploads live in image-refs.
    const served = new Set(['/data/images/example-ref.png', '/data/image-refs/init-0a1b.png', '/data/image-refs/ref-2c3d.png']);
    const fetchMock = vi.fn(async (url) => (served.has(url)
      ? { ok: true, blob: async () => new Blob(['x'], { type: 'image/png' }) }
      : { ok: false, status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await renderImageGenPage('/media/image?remix=' + encodeURIComponent(RECORD.filename));

      await waitFor(() => expect(state.initImagePickerProps?.initImage).toMatchObject({
        source: 'upload', name: 'init-0a1b.png', previewUrl: '/data/image-refs/init-0a1b.png',
      }));
      expect(state.initImagePickerProps.initImage.file).toBeInstanceOf(File);
      await waitFor(() => expect(state.referenceImagePickerProps?.referenceImages.slice(0, 2)).toMatchObject([
        { previewUrl: '/data/images/example-ref.png', strength: 0.5 },
        { previewUrl: '/data/image-refs/ref-2c3d.png', strength: 0.8 },
      ]));
      expect(state.referenceImagePickerProps.referenceImages[0].file).toBeInstanceOf(File);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
