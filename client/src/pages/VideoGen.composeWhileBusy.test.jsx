import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import {
  loadVideoGenPage,
  renderVideoGenPage,
  resetVideoGenMockState,
  state,
  videoGenModel,
  videoGenModelContext,
  videoGenStatus,
  videoGenTermsGate,
} from '../test/videoGenPageMocks.jsx';

const TERMS_ID = 'minimax-h3-license-v1';
const MODEL = videoGenModel('h3-one', { termsGate: videoGenTermsGate(TERMS_ID) });

await loadVideoGenPage();

describe('VideoGen compose-while-busy', () => {
  beforeEach(() => {
    resetVideoGenMockState();
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MODEL]));
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([MODEL]));
    state.modelStatuses = { [MODEL.id]: { id: MODEL.id, repo: MODEL.repo, cached: true, sizeBytes: 100 } };
    state.generateVideo.mockReturnValue(new Promise(() => {}));
    state.attach.mockReturnValue(new Promise(() => {}));
    vi.stubGlobal('open', vi.fn());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });
  });

  it('starts runtime installation through the non-idempotent POST stream', async () => {
    await renderVideoGenPage();

    expect(screen.getByTestId('runtime-install-modal')).toHaveAttribute('data-stream-method', 'POST');
  });

  it('leaves Enhance with AI and Prompt from media usable so the next clip can be queued', async () => {
    await renderVideoGenPage();

    const prompt = await screen.findByLabelText('Prompt');
    fireEvent.change(prompt, { target: { value: 'a fox watches the rain' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Generate$/ })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument());

    expect(screen.getByTestId('prompt-enhancer')).toHaveAttribute('data-disabled', '0');
    expect(screen.getByTestId('prompt-from-media')).toHaveAttribute('data-disabled', '0');
    expect(screen.getByRole('button', { name: /Add to queue/ })).toBeEnabled();
  });

  it('includes the selected universe style in the submitted video prompt', async () => {
    await renderVideoGenPage();

    fireEvent.click(screen.getByRole('button', { name: 'Use universe style' }));
    fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: 'a fox watches the rain' } });
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));

    await waitFor(() => expect(state.generateVideo).toHaveBeenCalled());
    expect(state.generateVideo.mock.calls[0][0].prompt).toBe('inky linework. a fox watches the rain');
  });

  it('submits an additional render to the server queue while another render is active', async () => {
    await renderVideoGenPage();

    const prompt = await screen.findByLabelText('Prompt');
    fireEvent.change(prompt, { target: { value: 'a fox watches the rain' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Generate$/ })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Add to queue/ }));
    await waitFor(() => expect(state.generateVideo).toHaveBeenCalledTimes(2));
    expect(state.generateVideo.mock.calls[1][0]).toMatchObject({
      mode: 'text',
      prompt: 'a fox watches the rain',
    });
  });
});
