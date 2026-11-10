import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { awaitEnabled } from '../test/enabledBarrier.js';
import { lastEventSource } from '../test/mockEventSource';

import {
  loadVideoGenPage,
  renderVideoGenPage,
  resetVideoGenMockState,
  state,
  videoGenModel,
  videoGenModelContext,
  videoGenStatus,
} from '../test/videoGenPageMocks.jsx';

const H3_ONE = videoGenModel('h3-one');
const H3_TWO = videoGenModel('h3-two');

await loadVideoGenPage();

const prompt = () => screen.getByLabelText('Prompt');
const generate = () => screen.getByRole('button', { name: /^Generate$/ });
const enqueue = () => screen.getByRole('button', { name: /Add to queue/ });

describe('VideoGen MiniMax H3 orchestration', () => {
  beforeEach(() => {
    localStorage.clear();
    resetVideoGenMockState();
    state.modelStatuses = {
      [H3_ONE.id]: { id: H3_ONE.id, repo: H3_ONE.repo, cached: true, sizeBytes: 100 },
      [H3_TWO.id]: { id: H3_TWO.id, repo: H3_TWO.repo, cached: true, sizeBytes: 100 },
    };
    state.generateVideo.mockResolvedValue({ jobId: 'job-1' });
    state.repair.mockResolvedValue({ ok: true });
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([H3_ONE, H3_TWO]));
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([H3_ONE, H3_TWO]));
  });

  it('lets H3 generate, queue, and switch models', async () => {
    await renderVideoGenPage();

    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(H3_ONE.id));
    fireEvent.change(prompt(), { target: { value: 'a fox watches the rain' } });

    await awaitEnabled(enqueue);
    fireEvent.click(enqueue());
    await waitFor(() => expect(state.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      modelId: H3_ONE.id,
    })));

    await act(async () => {
      fireEvent.submit(prompt().closest('form'));
    });
    await waitFor(() => expect(state.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      modelId: H3_ONE.id,
    })));

    // Finish the render so the page returns to idle and Generate is offered again.
    await waitFor(() => expect(lastEventSource()).toBeTruthy());
    await act(async () => { lastEventSource().emit({ type: 'complete', result: { filename: 'example.mp4' } }); });

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: H3_TWO.id } });
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(H3_TWO.id));
    expect(generate()).toBeEnabled();
    expect(enqueue()).toBeEnabled();
  });

  it('offers download for an uncached model', async () => {
    state.modelStatuses[H3_ONE.id] = { id: H3_ONE.id, repo: H3_ONE.repo, cached: false, sizeBytes: 0 };
    await renderVideoGenPage();

    const download = await screen.findByRole('button', { name: /Download/ });
    expect(download).toBeEnabled();
    fireEvent.click(download);
    expect(state.start).toHaveBeenCalledWith(H3_ONE.id);
  });

  it('offers integrity repair for a damaged model', async () => {
    state.modelStatuses[H3_ONE.id] = {
      id: H3_ONE.id,
      repo: H3_ONE.repo,
      cached: true,
      sizeBytes: 100,
      integrity: { status: 'bad', badFiles: [{ name: 'model.safetensors' }] },
    };
    await renderVideoGenPage();

    const repair = await screen.findByRole('button', { name: /Repair model/ });
    expect(repair).toBeEnabled();
    fireEvent.click(repair);
    expect(state.repair).toHaveBeenCalledWith(H3_ONE.id);
  });

  it('refreshes the model capability payload after runtime setup completes', async () => {
    await renderVideoGenPage();
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(H3_ONE.id));
    const beforeStatus = state.getVideoGenStatus.mock.calls.length;
    const beforeContext = state.getVideoGenModelContext.mock.calls.length;

    await act(async () => { await state.runtimeInstallComplete(); });

    // The install moves BOTH halves: the hardware decoration on the model list
    // and the python health the connectivity banner reads.
    await waitFor(() => expect(state.getVideoGenModelContext).toHaveBeenCalledTimes(beforeContext + 1));
    expect(state.getVideoGenStatus).toHaveBeenCalledTimes(beforeStatus + 1);
  });
});
