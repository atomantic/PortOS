import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { loadImageGenPage, renderImageGenPage, resetImageGenMockState, state } from '../test/imageGenPageMocks.jsx';

await loadImageGenPage();

const imagen = 'imagen-4.0-generate-001';
const gemini = 'gemini-3-pro-image';
const prompt = 'A lighthouse at dusk';
const pick = (name) => ({ target: { files: [new File(['image'], name, { type: 'image/jpeg' })] } });

describe('ImageGen text-only cloud models', () => {
  beforeEach(async () => {
    resetImageGenMockState();
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('no decoder'))));
    state.settings = { imageGen: { mode: 'google', google: { enabled: true, model: imagen } } };
    state.getImageGenStatus.mockResolvedValue({ connected: true, mode: 'google' });
    state.initImagePickerFactory = ({ initImage, onPick }) => (
      <button type="button" onClick={() => onPick(pick('source.jpg'))}>{initImage.name || 'Pick init'}</button>
    );
    state.referenceImagePickerFactory = ({ referenceImages, onPick }) => (
      <button type="button" onClick={() => onPick(0, pick('reference.jpg'))}>{referenceImages[0].file?.name || 'Pick reference'}</button>
    );
    await renderImageGenPage();
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: prompt } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { textOnlySelection: imagen, withInit: true },
    { textOnlySelection: '', withInit: false },
  ])('preserves selected images across a text-only model switch (%j)', async ({ textOnlySelection, withInit }) => {
    const model = screen.getByLabelText('Google model');
    const selectModel = (value) => fireEvent.change(model, { target: { value } });
    const actions = within(screen.getByTestId('image-primary-actions'));
    const generate = actions.getByRole('button', { name: 'Generate' });

    selectModel(gemini);
    if (withInit) {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pick init' })); });
    }
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pick reference' })); });
    expect(generate).toBeEnabled();

    selectModel(textOnlySelection);
    expect(generate).toBeDisabled();
    expect(actions.getByText(/text-only model.*switch/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /source\.jpg|reference\.jpg|Pick init|Pick reference/ })).toBeNull();
    await act(async () => { fireEvent.submit(generate.form); });
    expect(state.generateImage).not.toHaveBeenCalled();
    expect(state.generateImageMultipart).not.toHaveBeenCalled();

    selectModel(gemini);
    if (withInit) expect(screen.getByRole('button', { name: 'source.jpg' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'reference.jpg' })).toBeVisible();
    expect(generate).toBeEnabled();

    selectModel(textOnlySelection);
    fireEvent.click(actions.getByRole('button', { name: 'Clear selected images' }));
    expect(generate).toBeEnabled();
    await act(async () => { fireEvent.click(generate); });
    const [payload] = state.generateImage.mock.calls[0];
    expect(payload).toMatchObject({ mode: 'google', prompt });
    if (textOnlySelection) expect(payload.cloudModel).toBe(imagen);
    else expect(payload).not.toHaveProperty('cloudModel');
    expect(Object.keys(payload).filter((key) => /^(initImage|reference)/.test(key))).toEqual([]);
    expect(state.generateImageMultipart).not.toHaveBeenCalled();
  });
});
