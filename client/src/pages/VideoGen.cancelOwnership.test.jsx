import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import {
  loadVideoGenPage, renderVideoGenPage, resetVideoGenMockState, state,
  videoGenModel, videoGenModelContext, videoGenStatus,
} from '../test/videoGenPageMocks.jsx';
import { findEnabledByRole } from '../test/enabledBarrier.js';
import { cancelVideoGen, getActiveVideoJob } from '../services/api';
import { lastEventSource, MockEventSource } from '../test/mockEventSource';

const MODEL = videoGenModel('h3-one');

await loadVideoGenPage();

describe('Video Gen render ownership', () => {
  beforeEach(() => {
    resetVideoGenMockState();
    cancelVideoGen.mockClear();
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MODEL]));
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([MODEL]));
    state.modelStatuses = { [MODEL.id]: { id: MODEL.id, repo: MODEL.repo, cached: true, sizeBytes: 100 } };
  });

  // Reload mid-render used to leave the resumed job without an owned identity, so
  // Cancel closed the stream and said "Cancelled" while the render kept running.
  it('cancelling a resumed render cancels exactly that job', async () => {
    state.activeJob = { jobId: 'job-a', status: 'running', params: {} };
    await renderVideoGenPage();
    await waitFor(() => expect(lastEventSource()?.url).toBe('/api/video-gen/job-a/events'));
    const stream = lastEventSource();

    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /^cancel$/i })); });

    expect(cancelVideoGen).toHaveBeenCalledTimes(1);
    expect(cancelVideoGen).toHaveBeenCalledWith('job-a');
    expect(stream.closed).toBe(true);
  });

  it('a POST acknowledged after unmount opens no stream, and an unmounted active-job read is ignored', async () => {
    let acknowledge;
    state.generateVideo.mockReturnValue(new Promise((resolve) => { acknowledge = resolve; }));
    const view = await renderVideoGenPage();
    fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: 'a fox watches the rain' } });
    await findEnabledByRole('button', { name: /^Generate$/ });
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    await waitFor(() => expect(state.generateVideo).toHaveBeenCalled());
    view.unmount();
    await act(async () => { acknowledge({ jobId: 'job-durable' }); });
    expect(MockEventSource.instances).toHaveLength(0);
    expect(cancelVideoGen).not.toHaveBeenCalled();

    let resolveActive;
    getActiveVideoJob.mockReturnValueOnce(new Promise((resolve) => { resolveActive = resolve; }));
    const second = await renderVideoGenPage();
    second.unmount();
    await act(async () => { resolveActive({ activeJob: { jobId: 'job-running', status: 'running', params: {} } }); });
    expect(MockEventSource.instances).toHaveLength(0);
  });
});
