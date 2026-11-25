import { expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { findEnabledByRole } from '../test/enabledBarrier.js';
import {
  loadVideoGenPage, renderVideoGenPage, resetVideoGenMockState,
  state, videoGenModel, videoGenModelContext, videoGenStatus,
} from '../test/videoGenPageMocks.jsx';

await loadVideoGenPage();

it('offers a catalogued fal model’s lengths and submits the legacy field for a custom endpoint', async () => {
  const local = videoGenModel('local-model');
  resetVideoGenMockState();
  state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([local]));
  state.getVideoGenStatus.mockResolvedValue(videoGenStatus([local], { falEnabled: true }));
  state.generateVideo.mockResolvedValue({ jobId: 'job-1' });
  await renderVideoGenPage();
  fireEvent.click(await screen.findByRole('button', { name: 'fal.ai' }));
  const model = await screen.findByLabelText('fal.ai model');

  fireEvent.change(model, { target: { value: 'fal-ai/veo3.1/fast/image-to-video' } });
  const lengths = screen.getByRole('combobox', { name: 'Clip length' });
  expect([...lengths.options].map((option) => option.value)).toEqual(['', '4', '6', '8']);
  fireEvent.change(lengths, { target: { value: '8' } });

  fireEvent.change(model, { target: { value: 'example/custom-video' } });
  const seconds = screen.getByRole('spinbutton', { name: 'Clip length (sec)' });
  expect(seconds).toHaveAttribute('min', '1');
  expect(seconds).toHaveAttribute('max', '60');
  fireEvent.change(seconds, { target: { value: '7' } });
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Wind in the trees' } });
  fireEvent.click(await findEnabledByRole('button', { name: /Add to queue/ }));
  await waitFor(() => expect(state.generateVideo).toHaveBeenCalled());
  expect(state.generateVideo.mock.calls[0][0]).toMatchObject({ backend: 'fal', falModelId: 'example/custom-video', falDuration: '7' });
});
