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

const TERMS_ONE = 'minimax-h3-license-v1';
const TERMS_TWO = 'minimax-h3-license-v2';
const H3_ONE = videoGenModel('h3-one', { termsGate: videoGenTermsGate(TERMS_ONE) });
const H3_TWO = videoGenModel('h3-two', { termsGate: videoGenTermsGate(TERMS_TWO) });

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
    state.attach.mockImplementation(async (_jobId, handlers) => {
      handlers.onComplete({ result: { filename: 'example.mp4' } });
      return { filename: 'example.mp4' };
    });
  });

  it('lets H3 generate and queue with no eligibility checkbox', async () => {
    await renderVideoGenPage();

    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(H3_ONE.id));
    expect(screen.queryByRole('checkbox', { name: /I am eligible/ })).toBeNull();
    expect(screen.queryByText(/eligibility and terms/i)).toBeNull();
    fireEvent.change(prompt(), { target: { value: 'a fox watches the rain' } });

    await waitFor(() => expect(enqueue()).toBeEnabled());
    fireEvent.click(enqueue());
    await waitFor(() => expect(state.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      modelId: H3_ONE.id,
    })));
    expect(state.generateVideo.mock.calls[0][0]).not.toHaveProperty('termsAcceptance');

    await act(async () => {
      fireEvent.submit(prompt().closest('form'));
    });
    await waitFor(() => expect(state.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      modelId: H3_ONE.id,
    })));
    expect(state.generateVideo.mock.calls[0][0]).not.toHaveProperty('termsAcceptance');

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: H3_TWO.id } });
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(H3_TWO.id));
    expect(generate()).toBeEnabled();
    expect(enqueue()).toBeEnabled();
    expect(screen.queryByRole('checkbox', { name: /I am eligible/ })).toBeNull();
  });

  it('offers download without an eligibility acknowledgement', async () => {
    state.modelStatuses[H3_ONE.id] = { id: H3_ONE.id, repo: H3_ONE.repo, cached: false, sizeBytes: 0 };
    await renderVideoGenPage();

    const download = await screen.findByRole('button', { name: /Download/ });
    expect(download).toBeEnabled();
    fireEvent.click(download);
    expect(state.start).toHaveBeenCalledWith(H3_ONE.id);
  });

  it('offers integrity repair without an eligibility acknowledgement', async () => {
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
    const before = state.getVideoGenStatus.mock.calls.length;

    await act(async () => { await state.runtimeInstallComplete(); });

    await waitFor(() => expect(state.getVideoGenStatus).toHaveBeenCalledTimes(before + 1));
  });
});
