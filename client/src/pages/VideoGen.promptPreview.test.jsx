import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  loadVideoGenPage, renderVideoGenPage, resetVideoGenMockState,
  state, videoGenModel, videoGenModelContext, videoGenStatus,
} from '../test/videoGenPageMocks.jsx';

const MODEL = videoGenModel('local-model');
await loadVideoGenPage();

// #11317: the form shows what Generate will send, from the server's preview of
// the same request, and the refusal the render would give before the click.
describe('VideoGen prompt preview', () => {
  beforeEach(() => {
    localStorage.clear();
    resetVideoGenMockState();
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([MODEL]));
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MODEL], { falEnabled: true }));
    state.modelStatuses = { [MODEL.id]: { id: MODEL.id, repo: MODEL.repo, cached: true, sizeBytes: 100 } };
  });

  it('previews the Generate request and shows what the backend adds as chips', async () => {
    state.previewVideoPrompt.mockResolvedValue({
      backend: 'fal',
      sentPrompt: 'a fox watches the rain\nAvoid: blur',
      promptAdditions: [{ id: 'avoid', label: 'Negative prompt, sent as "Avoid:"', text: 'blur' }],
    });
    await renderVideoGenPage();
    fireEvent.click(await screen.findByRole('button', { name: 'fal.ai' }));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a fox watches the rain' } });

    await waitFor(() => expect(state.previewVideoPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'fal', prompt: 'a fox watches the rain' }),
      { silent: true },
    ), { timeout: 2000 });
    expect(await screen.findByRole('button', { name: '+ Negative prompt, sent as "Avoid:"' })).toBeTruthy();
    expect(screen.getByLabelText('Prompt')).toHaveValue('a fox watches the rain');
  });

  it('shows the refusal Generate would get', async () => {
    state.previewVideoPrompt.mockRejectedValue(new Error('The prompt is 2,001 characters; MiniMax Hailuo-02 Standard (text) takes 2,000. Shorten it to render.'));
    await renderVideoGenPage();
    fireEvent.click(await screen.findByRole('button', { name: 'fal.ai' }));
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'x'.repeat(2001) } });
    expect(await screen.findByRole('alert', {}, { timeout: 2000 })).toHaveTextContent('2,001 characters');
  });
});
