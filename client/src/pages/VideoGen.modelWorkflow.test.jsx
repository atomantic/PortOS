import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  loadVideoGenPage, renderVideoGenPage, resetVideoGenMockState, state,
  videoGenModel, videoGenModelContext, videoGenStatus,
} from '../test/videoGenPageMocks.jsx';

vi.doMock('../components/media/ResolutionField', async () => vi.importActual('../components/media/ResolutionField'));

await loadVideoGenPage();

beforeEach(() => {
  localStorage.clear();
  resetVideoGenMockState();
});

it('applies the FastH3 test canvas to the render form without starting a job', async () => {
  const model = videoGenModel('fasth3_v2_int6', {
    runtime: 'fastvideo', fastvideoFamily: 'fasth3', fastvideoVsa: true,
    steps: 8, samplerLocked: true, resolutionStep: 32,
    defaultWidth: 832, defaultHeight: 480,
    resolutionOptions: [{ label: '832×480', w: 832, h: 480 }],
  });
  state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([model]));
  state.getVideoGenStatus.mockResolvedValue(videoGenStatus([model]));
  await renderVideoGenPage();
  fireEvent.click(await screen.findByText('Choosing a model: preview → final'));
  fireEvent.click(await screen.findByRole('button', { name: 'Use 512×288 test size' }));
  await waitFor(() => expect(screen.getByLabelText('Width')).toHaveValue(512));
  expect(screen.getByLabelText('Height')).toHaveValue(288);
  expect(screen.getByText(/nearest multiple of 32/)).toBeInTheDocument();
  expect(screen.getByText(/same prompt/, { exact: false })).toBeInTheDocument();
  expect(state.generateVideo).not.toHaveBeenCalled();
});
