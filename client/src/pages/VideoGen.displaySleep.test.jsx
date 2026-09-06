import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import {
  loadVideoGenPage,
  renderVideoGenPage,
  resetVideoGenMockState,
  state,
  videoGenModel,
  videoGenModelContext,
  videoGenStatus,
} from '../test/videoGenPageMocks.jsx';

// `sleepsDisplayDuringRender` (server: runtimeUsesMlx(model.runtime)) is what
// the display-sleep control gates on — set directly rather than through an
// mlx_video runtime, which would also pull in the shared-text-encoder gate
// this suite isn't testing.
const MLX_MODEL = videoGenModel('mlx-one', { sleepsDisplayDuringRender: true });

await loadVideoGenPage();

// Fills the prompt, submits via Add to queue, and returns the `displaySleep`
// field the render was actually submitted with.
const submitAndGetDisplaySleep = async () => {
  fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: 'a fox watches the rain' } });
  await waitFor(() => expect(screen.getByRole('button', { name: /Add to queue/ })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /Add to queue/ }));
  await waitFor(() => expect(state.generateVideo).toHaveBeenCalled());
  return state.generateVideo.mock.calls[0][0].displaySleep;
};

describe('VideoGen per-render display-sleep control', () => {
  beforeEach(() => {
    resetVideoGenMockState();
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([MLX_MODEL]));
    state.modelStatuses = { [MLX_MODEL.id]: { id: MLX_MODEL.id, repo: MLX_MODEL.repo, cached: true, sizeBytes: 100 } };
    state.generateVideo.mockResolvedValue({ jobId: 'job-1' });
    state.attach.mockReturnValue(new Promise(() => {}));
  });

  it('defaults the checkbox to the install setting and sends the choice with the render', async () => {
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MLX_MODEL], { displaySleepOnRender: true }));
    await renderVideoGenPage();

    const checkbox = await screen.findByLabelText(/Sleep display during this render/i);
    await waitFor(() => expect(checkbox).toBeChecked());

    expect(await submitAndGetDisplaySleep()).toBe('true');
  });

  it('lets the user opt out for just this render, without changing Settings', async () => {
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MLX_MODEL], { displaySleepOnRender: true }));
    await renderVideoGenPage();

    const checkbox = await screen.findByLabelText(/Sleep display during this render/i);
    await waitFor(() => expect(checkbox).toBeChecked());
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();

    expect(await submitAndGetDisplaySleep()).toBe('false');
  });

  it('defaults to off, and lets the user opt in for just this render, when the install default is off', async () => {
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MLX_MODEL], { displaySleepOnRender: false }));
    await renderVideoGenPage();

    const checkbox = await screen.findByLabelText(/Sleep display during this render/i);
    await waitFor(() => expect(checkbox).not.toBeChecked());
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    expect(await submitAndGetDisplaySleep()).toBe('true');
  });

  it('does not offer the control for a runtime the mitigation never applies to', async () => {
    const nonMlxModel = videoGenModel('h3-one');
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([nonMlxModel]));
    state.modelStatuses = { [nonMlxModel.id]: { id: nonMlxModel.id, repo: nonMlxModel.repo, cached: true, sizeBytes: 100 } };
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([nonMlxModel], { displaySleepOnRender: false }));
    await renderVideoGenPage();

    await screen.findByLabelText('Prompt');
    expect(screen.queryByLabelText(/Sleep display during this render/i)).toBeNull();
  });
});
