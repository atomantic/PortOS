import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { findEnabledByRole } from '../test/enabledBarrier.js';
import {
  loadVideoGenPage, renderVideoGenPage, resetVideoGenMockState,
  state, videoGenModel, videoGenModelContext, videoGenStatus,
} from '../test/videoGenPageMocks.jsx';

const MODEL = videoGenModel('local-model');
await loadVideoGenPage();

describe('VideoGen Runway text lane', () => {
  beforeEach(() => {
    localStorage.clear();
    resetVideoGenMockState();
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([MODEL]));
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MODEL], { runwayEnabled: true }));
    state.generateVideo.mockResolvedValue({ jobId: 'job-1' });
  });

  it('switches from an image-only model to a priced text-capable model and submits without a frame', async () => {
    await renderVideoGenPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Runway' }));
    const modes = within(screen.getByRole('group', { name: 'Video generation mode' }));
    fireEvent.click(modes.getByRole('button', { name: 'Image' }));
    const model = await screen.findByLabelText('Runway model');
    fireEvent.change(model, { target: { value: 'gen4_turbo' } });
    expect(model).toHaveValue('gen4_turbo');
    fireEvent.click(modes.getByRole('button', { name: 'Text' }));
    await waitFor(() => expect(model).toHaveValue('gen4.5'));
    expect([...model.options].map(option => option.value)).toEqual(['gen4.5']);
    expect(screen.getByText(/about \$0.60 at list price/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a fox watches the rain' } });
    fireEvent.click(await findEnabledByRole('button', { name: /Add to queue/ }));
    await waitFor(() => expect(state.generateVideo).toHaveBeenCalled());
    const payload = state.generateVideo.mock.calls[0][0];
    expect(payload).toMatchObject({ backend: 'runway', prompt: 'a fox watches the rain' });
    expect(payload.sourceImageFile).toBe('');
    expect(payload.sourceImage).toBe('');
  });
});
