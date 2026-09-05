import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import {
  loadVideoGenPage,
  renderVideoGenPage,
  resetVideoGenMockState,
  state,
  videoGenModel,
  videoGenModelContext,
  videoGenStatus,
} from '../test/videoGenPageMocks.jsx';
import {
  REACTOR_MAX_PROMPT_LENGTH, REACTOR_MIN_CLIP_SECONDS, REACTOR_MAX_CLIP_SECONDS,
} from '../lib/reactorVideoClip.js';

// A local model that DOES take a negative prompt, so "the box is gone" can only
// be explained by the reactor lane rather than by the model's own gate.
const MODEL = videoGenModel('local-model', { supportsNegativePrompt: true });

const REACTOR_RENDER = {
  id: 'video-1',
  prompt: 'A camera holds on a quiet gate',
  filename: 'video-1.mp4',
  modelId: 'reactor:fast-h3',
  clipId: 'clip-example',
  createdAt: new Date().toISOString(),
};
const LOCAL_RENDER = {
  id: 'video-2',
  prompt: 'A local render with no reactor clip',
  filename: 'video-2.mp4',
  modelId: 'local-model',
  createdAt: new Date().toISOString(),
};

await loadVideoGenPage();

const selectReactor = async () => {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Reactor.inc' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Reactor.inc' }));
  await screen.findByLabelText('Clip length');
};

const submit = async () => {
  await waitFor(() => expect(screen.getByRole('button', { name: /Add to queue/ })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /Add to queue/ }));
  await waitFor(() => expect(state.generateVideo).toHaveBeenCalled());
  return state.generateVideo.mock.calls[0][0];
};

describe('VideoGen reactor.inc lane', () => {
  beforeEach(() => {
    localStorage.clear();
    resetVideoGenMockState();
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([MODEL]));
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MODEL], { reactorEnabled: true }));
    state.modelStatuses = { [MODEL.id]: { id: MODEL.id, repo: MODEL.repo, cached: true, sizeBytes: 100 } };
    state.listVideoHistory.mockResolvedValue([REACTOR_RENDER, LOCAL_RENDER]);
    state.generateVideo.mockResolvedValue({ jobId: 'job-1' });
    state.attach.mockReturnValue(new Promise(() => {}));
  });

  // The 800-character cap used to surface only as a 400 after Generate, naming
  // a number the form never showed.
  it('counts the prompt against the cap and refuses to submit an over-long one', async () => {
    await renderVideoGenPage();
    await selectReactor();

    const promptField = screen.getByLabelText('Prompt');
    fireEvent.change(promptField, { target: { value: 'a fox watches the rain' } });
    expect(screen.getByText(`22 / ${REACTOR_MAX_PROMPT_LENGTH} characters`)).toBeInTheDocument();

    fireEvent.change(promptField, { target: { value: 'x'.repeat(REACTOR_MAX_PROMPT_LENGTH + 1) } });
    await waitFor(() => expect(screen.getByText(/Reactor will reject this/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Add to queue/ })).toBeDisabled();

    fireEvent.change(promptField, { target: { value: 'x'.repeat(REACTOR_MAX_PROMPT_LENGTH) } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Add to queue/ })).toBeEnabled());
  });

  // fast-h3's enqueue command has no negative-prompt field, so the box only
  // ever collected text nothing would submit.
  it('drops the negative prompt the backend has no field for', async () => {
    await renderVideoGenPage();
    expect(await screen.findByLabelText('Negative Prompt')).toBeInTheDocument();

    await selectReactor();
    expect(screen.queryByLabelText('Negative Prompt')).toBeNull();

    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a fox watches the rain' } });
    expect(await submit()).not.toHaveProperty('negativePrompt');
  });

  // The accepted range neither starts nor ends on a round number, so the old
  // free-text seconds box mostly offered a way to type a rejected value.
  it('offers clip lengths fast-h3 accepts instead of a free-text duration', async () => {
    await renderVideoGenPage();
    await selectReactor();

    const lengths = screen.getByLabelText('Clip length');
    expect(lengths.tagName).toBe('SELECT');
    const offered = [...lengths.options].map((option) => Number(option.value));
    expect(offered[0]).toBe(REACTOR_MIN_CLIP_SECONDS);
    expect(offered[offered.length - 1]).toBe(REACTOR_MAX_CLIP_SECONDS);
    expect(Number(lengths.value)).toBe(6);

    fireEvent.change(lengths, { target: { value: String(REACTOR_MAX_CLIP_SECONDS) } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a fox watches the rain' } });
    expect((await submit()).reactorSeconds).toBe(REACTOR_MAX_CLIP_SECONDS);
  });

  // The clip id is stamped on every finished reactor render precisely so a
  // later one can chain off it — a text box asked the user to know an id they
  // are never shown.
  it('picks a continuation from the clip ids previous reactor renders stored', async () => {
    await renderVideoGenPage();
    await selectReactor();

    const picker = screen.getByLabelText('Continue from clip');
    const offered = [...picker.options].map((option) => option.value);
    expect(offered).toEqual(['', REACTOR_RENDER.clipId]);
    expect(screen.getByRole('option', { name: /A camera holds on a quiet gate/ })).toBeInTheDocument();

    fireEvent.change(picker, { target: { value: REACTOR_RENDER.clipId } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'the gate swings open' } });
    expect((await submit()).reactorClipId).toBe(REACTOR_RENDER.clipId);
  });

  // The option disappears with the render, so the picker would show "Start a
  // fresh shot" while the submission still carried the deleted clip's id.
  it('drops a continuation whose render is no longer in history', async () => {
    await renderVideoGenPage();
    await selectReactor();

    fireEvent.change(screen.getByLabelText('Continue from clip'), { target: { value: REACTOR_RENDER.clipId } });

    // The render leaves history (deleted, or hidden) and the page refreshes.
    state.listVideoHistory.mockResolvedValue([LOCAL_RENDER]);
    await act(async () => { await state.completionRefresh.onVideoCompleted(); });

    await waitFor(() => expect(screen.getByLabelText('Continue from clip')).toBeDisabled());
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'the gate swings open' } });
    expect((await submit()).reactorClipId).toBeUndefined();
  });

  it('offers no continuation until a reactor render has stored a clip id', async () => {
    state.listVideoHistory.mockResolvedValue([LOCAL_RENDER]);
    await renderVideoGenPage();
    await selectReactor();

    const picker = screen.getByLabelText('Continue from clip');
    expect(picker).toBeDisabled();
    expect(picker.options).toHaveLength(1);
    expect(picker.options[0].textContent).toMatch(/No Reactor clips rendered yet/);
  });
});
