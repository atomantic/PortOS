/**
 * Picking a substitute prompt conditioner starts its download right there.
 *
 * The conditioner is unusable until it is resident and Generate is gated on it
 * either way, so the separate Download click sat between the choice and the only
 * thing that could follow it. What this file pins down is the boundary: an
 * EXPLICIT selection pulls, and a state restore (a resumed render, a Remix, the
 * snap-to-stock on a model change) never does — those all reach the same
 * setTextEncoderId, and a ~57 GB pull must follow a click, not a restore.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import {
  loadVideoGenPage,
  renderVideoGenPage,
  resetVideoGenMockState,
  state,
  videoGenModel,
  videoGenStatus,
  videoGenTermsGate,
} from '../test/videoGenPageMocks.jsx';

const TERMS_ID = 'minimax-h3-license-v1';
const MODEL = videoGenModel('h3-one', {
  textEncoderOptions: [
    { id: 'stock', label: 'Stock', description: 'Ships with the model.', builtIn: true },
    { id: 'huihui-abliterated', label: 'Huihui abliterated', description: 'Abliterated.', builtIn: false, repo: 'example-org/abliterated', sizeBytes: 56962931632 },
  ],
  termsGate: videoGenTermsGate(TERMS_ID),
});

await loadVideoGenPage();

const SUBSTITUTE_ID = 'huihui-abliterated';
const DOWNLOAD_ID = `__text_encoder_option__:${SUBSTITUTE_ID}`;

const mountPage = async () => {
  await renderVideoGenPage();
  return screen.findByLabelText('Text encoder');
};

describe('VideoGen substitute text-encoder auto-download', () => {
  beforeEach(() => {
    resetVideoGenMockState();
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MODEL]));
    // The substitute is never resident: what these cases pin down is the
    // request, and a cached encoder would short-circuit it.
    state.getModelStatus = (id) => (String(id).startsWith('__text_encoder_option__:')
      ? { id: SUBSTITUTE_ID, repo: 'example-org/abliterated', cached: false, sizeBytes: 0 }
      : { id: MODEL.id, repo: MODEL.repo, cached: true, sizeBytes: 100 });
  });

  it('requests the pull when a substitute is selected', async () => {
    const select = await mountPage();
    // Arriving on the page with stock selected requests nothing.
    expect(state.startWhenIdle).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.change(select, { target: { value: SUBSTITUTE_ID } });
    });
    await waitFor(() => expect(state.startWhenIdle).toHaveBeenCalledWith(DOWNLOAD_ID));
    // The commanding `start` is NOT used here — it would hijack the lane and
    // skip the cache check that makes selecting a resident encoder free.
    expect(state.start).not.toHaveBeenCalled();
  });

  // The built-in conditioner ships inside the model's weights, so there is
  // nothing to fetch — and switching to it must retract a pull queued a moment
  // earlier for the substitute the user just moved off.
  it('clears the request when the selection goes back to stock', async () => {
    const select = await mountPage();
    await act(async () => {
      fireEvent.change(select, { target: { value: SUBSTITUTE_ID } });
    });
    await act(async () => {
      fireEvent.change(select, { target: { value: 'stock' } });
    });
    expect(state.startWhenIdle).toHaveBeenLastCalledWith(null);
  });

  it('surfaces the queued state on the selected substitute', async () => {
    state.queuedModelId = DOWNLOAD_ID;
    const select = await mountPage();
    await act(async () => {
      fireEvent.change(select, { target: { value: SUBSTITUTE_ID } });
    });
    await waitFor(() => expect(screen.getByText(/starts when the current download finishes/i)).toBeInTheDocument());
  });

  // Reloading onto an in-flight render replays its conditioner into the form.
  // That is a state restore, not a choice — and the weights are demonstrably
  // already resident, since the render is running on them. Remix (applyRemix)
  // and the model-change snap reach setTextEncoderId the same way, which is why
  // only the picker's own onChange requests a pull.
  it('requests nothing when a resumed render restores its conditioner', async () => {
    state.activeJob = {
      jobId: 'job-1',
      status: 'running',
      params: { modelId: MODEL.id, prompt: 'a fox watches the rain', mode: 'text', textEncoderId: SUBSTITUTE_ID },
    };
    await mountPage();
    await waitFor(() => expect(screen.getByLabelText('Text encoder')).toHaveValue(SUBSTITUTE_ID));
    expect(state.startWhenIdle).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
  });
});
