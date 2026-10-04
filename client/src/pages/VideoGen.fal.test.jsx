import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { findEnabledByRole } from '../test/enabledBarrier.js';
import {
  loadVideoGenPage, renderVideoGenPage, resetVideoGenMockState,
  state, videoGenModel, videoGenModelContext, videoGenStatus,
} from '../test/videoGenPageMocks.jsx';

const MODEL = videoGenModel('local-model');
await loadVideoGenPage();

describe('VideoGen curated fal controls (#9232)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetVideoGenMockState();
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([MODEL]));
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MODEL], { falEnabled: true }));
    state.modelStatuses = { [MODEL.id]: { id: MODEL.id, repo: MODEL.repo, cached: true, sizeBytes: 100 } };
    state.generateVideo.mockResolvedValue({ jobId: 'job-1' });
  });

  // Pins field-state → form → submission and pricing before enqueue, including
  // settings disappearing when the selected model no longer offers them.
  it('prices and submits selected options, then clears them for another model', async () => {
    await renderVideoGenPage();
    fireEvent.click(await screen.findByRole('button', { name: 'fal.ai' }));
    const model = await screen.findByLabelText('fal.ai model');
    expect(screen.queryByLabelText('Resolution')).toBeNull();
    expect(screen.queryByLabelText('Provider audio')).toBeNull();

    fireEvent.change(model, { target: { value: 'fal-ai/veo3.1/fast/image-to-video' } });
    const resolution = await screen.findByLabelText('Resolution');
    expect([...resolution.options].map((option) => option.value)).toEqual(['', '720p', '1080p', '4k']);
    expect(resolution.value).toBe('');
    expect(screen.getByLabelText('Provider audio')).not.toBeChecked();
    expect(screen.getByText(/about \$0.80 at list price/)).toHaveTextContent('provider audio off');

    fireEvent.change(resolution, { target: { value: '4k' } });
    expect(screen.getByText(/about \$2.40 at list price/)).toHaveTextContent('at 4k');
    fireEvent.click(screen.getByLabelText('Provider audio'));
    expect(screen.getByText(/about \$2.80 at list price/)).toHaveTextContent('provider audio on');
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a fox watches the rain' } });
    await findEnabledByRole('button', { name: /Add to queue/ });
    fireEvent.click(screen.getByRole('button', { name: /Add to queue/ }));
    await waitFor(() => expect(state.generateVideo).toHaveBeenCalled());
    expect(state.generateVideo.mock.calls[0][0]).toMatchObject({
      backend: 'fal', falResolution: '4k', falGenerateAudio: true,
    });

    fireEvent.change(model, { target: { value: 'fal-ai/kling-video/v3/pro/image-to-video' } });
    expect(screen.queryByLabelText('Resolution')).toBeNull();
    expect(screen.getByLabelText('Provider audio')).not.toBeChecked();
    fireEvent.change(model, { target: { value: 'example/custom-video' } });
    expect(screen.queryByLabelText('Resolution')).toBeNull();
    expect(screen.queryByLabelText('Provider audio')).toBeNull();
    expect(screen.getByText(/cost unknown for this model/)).toBeInTheDocument();
    fireEvent.change(model, { target: { value: 'fal-ai/veo3.1/fast/image-to-video' } });
    expect(screen.getByLabelText('Resolution').value).toBe('');
    expect(screen.getByLabelText('Provider audio')).not.toBeChecked();
  });
});
