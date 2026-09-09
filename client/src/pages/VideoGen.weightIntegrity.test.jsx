import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  loadVideoGenPage, renderVideoGenPage, resetVideoGenMockState, state,
  videoGenModel, videoGenModelContext, videoGenStatus,
} from '../test/videoGenPageMocks.jsx';

const MODEL = videoGenModel('example-ltx', {
  name: 'Example LTX', runtime: 'ltx2', supportedModes: ['text', 'ic-control'],
  textEncoderOptions: [
    { id: 'stock', label: 'Stock', builtIn: true },
    { id: 'substitute', label: 'Substitute', builtIn: false, repo: 'example/encoder' },
  ],
});
const ASSETS = [
  { id: MODEL.id, repair: 'Repair model', label: 'selected model weights' },
  { id: '__text_encoder__', repair: 'Repair encoder', label: 'shared text encoder' },
  { id: '__text_encoder_option__:substitute', repair: 'Repair text encoder', label: 'Substitute text encoder' },
  { id: 'ic-control', repair: 'Repair Control', label: 'Control weight' },
];
const ready = () => ({ cached: true, repo: 'example/weights' });
const bad = names => ({ ...ready(), integrity: { status: 'bad', badFiles: names.map(name => ({ name })) } });
const setStatus = (id, status) => {
  if (id === '__text_encoder__') state.modelDownloadExtra.textEncoder = status;
  else state.modelStatuses[id] = status;
};
const generate = () => screen.getByRole('button', { name: 'Generate', exact: true });
const enqueue = () => screen.getByRole('button', { name: 'Add to queue', exact: true });
let revision = 0;
const refreshRender = () => fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: `scene ${++revision}` } });
const mountAssets = async () => {
  await renderVideoGenPage();
  await screen.findByLabelText('Text encoder');
  fireEvent.change(screen.getByLabelText('Text encoder'), { target: { value: 'substitute' } });
  fireEvent.click(screen.getByRole('button', { name: 'Control', exact: true }));
  refreshRender();
};
await loadVideoGenPage();

describe('VideoGen downloadable asset integrity', () => {
  beforeEach(() => {
    localStorage.clear();
    resetVideoGenMockState();
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MODEL]));
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([MODEL]));
    for (const asset of ASSETS) setStatus(asset.id, ready());
  });

  // Each descriptor has a different status source and repair id: the page
  // boundary catches miswiring that testing the shared hook alone cannot.
  it.each(ASSETS)('isolates $repair dismissal and re-shows changed damage', async (asset) => {
    for (const entry of ASSETS) setStatus(entry.id, bad(['one.safetensors', 'two.safetensors']));
    await mountAssets();
    const repair = await screen.findByRole('button', { name: asset.repair, exact: true });
    const banner = repair.parentElement.parentElement;
    expect(banner).toHaveTextContent('2 damaged');
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('button', { name: asset.repair, exact: true })).toBeNull();
    for (const other of ASSETS.filter(entry => entry.id !== asset.id)) {
      expect(screen.getByRole('button', { name: other.repair, exact: true })).toBeVisible();
    }
    setStatus(asset.id, bad(['one.safetensors', 'two.safetensors']));
    refreshRender();
    expect(screen.queryByRole('button', { name: asset.repair, exact: true })).toBeNull();
    setStatus(asset.id, bad(['changed.safetensors']));
    refreshRender();
    const changedRepair = await screen.findByRole('button', { name: asset.repair, exact: true });
    expect(changedRepair.parentElement.parentElement).toHaveTextContent('1 damaged');
    fireEvent.click(changedRepair);
    expect(state.repair).toHaveBeenCalledWith(asset.id);
  });

  it.each(ASSETS)('names missing $label before generating', async (asset) => {
    setStatus(asset.id, { cached: false });
    await mountAssets();
    await waitFor(() => expect(generate()).toHaveAttribute('title', `Download the ${asset.label} before generating`));
    expect(generate()).toBeDisabled();
    expect(enqueue()).toBeDisabled();
    expect(enqueue()).toHaveAttribute('title', `Download the ${asset.label} before queueing`);
  });
});
