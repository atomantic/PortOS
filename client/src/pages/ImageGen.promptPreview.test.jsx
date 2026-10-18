import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import {
  loadImageGenPage,
  renderImageGenPage,
  resetImageGenMockState,
  state,
} from '../test/imageGenPageMocks.jsx';

const InitPicker = ({ onPick }) => (
  <button type="button" onClick={() => onPick({ target: { files: [new File(['x'], 'photo.jpg', { type: 'image/jpeg' })] } })}>pick-init</button>
);

await loadImageGenPage();

// #11317: the form shows what Generate will send, from the server's preview.
// The preview body is the Generate request with the upload named by count
// (no bytes ride a JSON body), and the box keeps only the typed words.
describe('ImageGen prompt preview', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    resetImageGenMockState();
    state.settings = { imageGen: { mode: 'codex' } };
    state.getImageGenStatus.mockResolvedValue({ connected: true, mode: 'codex' });
    state.initImagePickerFactory = InitPicker;
    state.previewImagePrompt.mockResolvedValue({
      mode: 'codex',
      sentPrompt: '$imagegen Edit the attached image: a red fox',
      promptAdditions: [{ id: 'agent-instructions', label: 'Codex image tool instructions', text: '$imagegen Edit the attached image: [prompt]' }],
    });
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('no decoder'))));
  });

  it('leaves an untouched Codex form quiet but previews image-only edits', async () => {
    await renderImageGenPage('/media/image');
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: '   ' } });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(state.previewImagePrompt).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'pick-init' })); });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(state.previewImagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '', uploadedInitImage: true }),
      { silent: true },
    );
  });

  it('previews the request with the upload counted and shows the additions as chips', async () => {
    await renderImageGenPage('/media/image');
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a red fox' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'pick-init' })); });

    await waitFor(() => expect(state.previewImagePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'a red fox', uploadedInitImage: true }),
      { silent: true },
    ), { timeout: 2000 });
    const body = state.previewImagePrompt.mock.calls.at(-1)[0];
    expect(body).not.toHaveProperty('initImage');

    expect(await screen.findByRole('button', { name: '+ Codex image tool instructions' })).toBeTruthy();
    expect(screen.getByLabelText('Prompt')).toHaveValue('a red fox');
  });
});
