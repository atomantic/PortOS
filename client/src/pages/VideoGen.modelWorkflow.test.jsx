import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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

it('finds an image-only model in Text mode and switches mode when it is selected', async () => {
  const textModel = videoGenModel('example-text', { supportedModes: ['text'] });
  const omni = videoGenModel('fasth3_omni_int6', {
    name: 'FastH3 Omni', runtime: 'fastvideo', supportedModes: ['image'],
  });
  const models = [textModel, omni];
  state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext(models));
  state.getVideoGenStatus.mockResolvedValue(videoGenStatus(models));
  await renderVideoGenPage();
  const picker = await screen.findByLabelText('Model');
  expect(screen.getByRole('button', { name: 'Text', pressed: true })).toBeInTheDocument();
  const otherModes = within(picker).getByRole('group', { name: 'Other modes (select to switch)' });
  expect(within(otherModes).getByRole('option', { name: 'FastH3 Omni — Image → video only' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'A paper bird takes flight' } });
  fireEvent.change(picker, { target: { value: omni.id } });
  await waitFor(() => expect(picker).toHaveValue(omni.id));
  expect(screen.getByRole('button', { name: 'Image', pressed: true })).toBeInTheDocument();
  expect(screen.getByLabelText('Prompt')).toHaveValue('A paper bird takes flight');
  expect(within(picker).getByRole('option', { name: 'FastH3 Omni' }).selected).toBe(true);
  expect(within(picker).getByRole('option', { name: /Text → video only/ })).toHaveValue(textModel.id);
  expect(state.generateVideo).not.toHaveBeenCalled();

  fireEvent.change(picker, { target: { value: textModel.id } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Text', pressed: true })).toBeInTheDocument());
  expect(picker).toHaveValue(textModel.id);
});

it('keeps compatible picks in the current mode and retains legacy models in other modes', async () => {
  const flexible = videoGenModel('example-flexible', { supportedModes: ['text', 'image'] });
  const legacy = videoGenModel('example-legacy', { name: 'Example Legacy', supportedModes: ['image'], deprecated: true });
  const models = [flexible, legacy];
  state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext(models));
  state.getVideoGenStatus.mockResolvedValue(videoGenStatus(models));
  await renderVideoGenPage();
  const picker = await screen.findByLabelText('Model');
  expect(within(picker).getByRole('option', { name: 'Example Legacy (Legacy) — Image → video only' })).toBeEnabled();
  fireEvent.change(picker, { target: { value: legacy.id } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Image', pressed: true })).toBeInTheDocument());
  expect(within(picker).getByRole('group', { name: 'Legacy' })).toHaveTextContent('Example Legacy');
  expect(within(picker).queryByRole('group', { name: 'Other modes (select to switch)' })).toBeNull();
  fireEvent.change(picker, { target: { value: flexible.id } });
  expect(screen.getByRole('button', { name: 'Image', pressed: true })).toBeInTheDocument();
  expect(picker).toHaveValue(flexible.id);
});
