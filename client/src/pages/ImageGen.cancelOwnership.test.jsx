import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { loadImageGenPage, renderImageGenPage, resetImageGenMockState, state } from '../test/imageGenPageMocks.jsx';
import { cancelImageGen } from '../services/api';
import { lastEventSource, MockEventSource } from '../test/mockEventSource';

await loadImageGenPage();

describe('Image Gen render ownership', () => {
  beforeEach(() => {
    resetImageGenMockState();
    cancelImageGen.mockClear();
  });

  // The legacy server selection cancels the MOST RECENT queued job, so the
  // displayed render A kept running while B was cancelled and the page said
  // "Cancelled".
  it('cancels the displayed render, not the job queued after it', async () => {
    state.generateImage.mockResolvedValueOnce({ jobId: 'job-a' }).mockResolvedValueOnce({ jobId: 'job-b', status: 'queued' });
    await renderImageGenPage();
    fireEvent.click(screen.getByRole('button', { name: /^generate$/i }));
    await waitFor(() => expect(lastEventSource()?.url).toBe('/api/image-gen/job-a/events'));
    const streamA = lastEventSource();

    fireEvent.click(await screen.findByRole('button', { name: /^queue$/i }));
    await waitFor(() => expect(state.generateImage).toHaveBeenCalledTimes(2));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /cancel/i })); });

    expect(cancelImageGen).toHaveBeenCalledTimes(1);
    expect(cancelImageGen).toHaveBeenCalledWith({ jobId: 'job-a' });
    expect(streamA.closed).toBe(true);
    // B was queued independently and stays untouched: no stream, no cancel.
    expect(MockEventSource.instances).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^generate$/i })).toBeInTheDocument();
  });

  it('cancel before the POST is acknowledged cancels the eventual job once and opens no stream', async () => {
    let acknowledge;
    state.generateImage.mockReturnValueOnce(new Promise((resolve) => { acknowledge = resolve; }));
    await renderImageGenPage();
    fireEvent.click(screen.getByRole('button', { name: /^generate$/i }));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /cancel/i })); });
    expect(cancelImageGen).not.toHaveBeenCalled();

    await act(async () => { acknowledge({ jobId: 'job-late' }); });
    expect(cancelImageGen).toHaveBeenCalledTimes(1);
    expect(cancelImageGen).toHaveBeenCalledWith({ jobId: 'job-late' });
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('a resumed render is cancelled by its own id, and an unmount mid-read opens no stream', async () => {
    state.activeJob = { generationId: 'job-resumed', status: 'running', params: {} };
    const view = await renderImageGenPage();
    await waitFor(() => expect(lastEventSource()?.url).toBe('/api/image-gen/job-resumed/events'));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /cancel/i })); });
    expect(cancelImageGen).toHaveBeenCalledWith({ jobId: 'job-resumed' });
    view.unmount();

    MockEventSource.reset();
    let resolveActive;
    const { getActiveImageJob } = await import('../services/api');
    getActiveImageJob.mockReturnValueOnce(new Promise((resolve) => { resolveActive = resolve; }));
    const second = await renderImageGenPage();
    second.unmount();
    await act(async () => { resolveActive({ activeJob: { generationId: 'job-durable', status: 'running', params: {} } }); });
    expect(MockEventSource.instances).toHaveLength(0);
  });
});
