import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it.each([
    ['Video edit', 'aleph2', 'Source video'],
    ['Character performance', 'act_two', 'Performance video'],
  ])('submits %s through its own model and video inputs without inventing a prompt', async (label, modelId, videoLabel) => {
    await renderVideoGenPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Runway' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Video generation mode' })).getByRole('button', { name: label }));
    const model = await screen.findByLabelText('Runway model');
    expect([...model.options].map((o) => o.value)).toEqual([modelId]);
    const source = new File([new Uint8Array(1024)], 'performance.mp4', { type: 'video/mp4' });
    expect(screen.getByRole('button', { name: /Add to queue/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(videoLabel), { target: { files: [source] } });
    if (modelId === 'act_two') {
      expect(screen.queryByLabelText('Prompt')).toBeNull();
      expect(screen.getByRole('button', { name: /Add to queue/ })).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Character video (instead of an image)'), { target: { files: [source] } });
      fireEvent.change(screen.getByLabelText('Expression intensity'), { target: { value: '4' } });
    }
    fireEvent.click(await findEnabledByRole('button', { name: /Add to queue/ }));
    await waitFor(() => expect(state.generateVideo).toHaveBeenCalled());
    expect(state.generateVideo.mock.calls[0][0]).toMatchObject({ backend: 'runway', runwayModelId: modelId, runwayVideo: source, prompt: '', mode: modelId === 'aleph2' ? 'video-edit' : 'character-performance' });
    if (modelId === 'act_two') expect(state.generateVideo.mock.calls[0][0]).toMatchObject({ runwayCharacterVideo: source, runwayExpressionIntensity: 4 });
  });

  it('clears file selections when switching special workflows and allows reselecting the same file', async () => {
    await renderVideoGenPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Runway' }));
    const modes = within(screen.getByRole('group', { name: 'Video generation mode' }));
    fireEvent.click(modes.getByRole('button', { name: 'Video edit' }));
    const firstInput = screen.getByLabelText('Source video');
    const source = new File([new Uint8Array(1024)], 'source.mp4', { type: 'video/mp4' });
    fireEvent.change(firstInput, { target: { files: [source] } });
    await findEnabledByRole('button', { name: /Add to queue/ });
    fireEvent.click(modes.getByRole('button', { name: 'Character performance' }));
    expect(screen.getByLabelText('Performance video')).not.toBe(firstInput);
    expect(screen.getByLabelText('Performance video').files).toHaveLength(0);
    fireEvent.click(modes.getByRole('button', { name: 'Video edit' }));
    const resetInput = screen.getByLabelText('Source video');
    expect(resetInput.files).toHaveLength(0);
    expect(screen.getByRole('button', { name: /Add to queue/ })).toBeDisabled();
    fireEvent.change(resetInput, { target: { files: [source] } });
    fireEvent.click(await findEnabledByRole('button', { name: /Add to queue/ }));
    await waitFor(() => expect(state.generateVideo).toHaveBeenCalled());
    expect(state.generateVideo.mock.calls[0][0]).toMatchObject({ runwayVideo: source });
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
    expect([...model.options].map(option => option.value)).toEqual(expect.arrayContaining(['gen4.5', 'veo3.1', 'seedance2_5']));
    expect([...model.options].map(option => option.value)).not.toContain('gen4_turbo');
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

vi.mock('../services/apiRunwayCatalog.js', async (importOriginal) => ({ ...await importOriginal(), loadRunwayCatalog: vi.fn().mockResolvedValue(undefined) }));
