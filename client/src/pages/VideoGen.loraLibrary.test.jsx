/**
 * The LoRA picker's library read (#12040): a failed load shows an error row
 * with Retry, and a genuinely empty library shows its own empty copy —
 * neither renders as the other.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import {
  state, resetVideoGenMockState, videoGenModel, videoGenStatus, videoGenModelContext,
  loadVideoGenPage, renderVideoGenPage,
} from '../test/videoGenPageMocks.jsx';

await loadVideoGenPage();

const MODEL = videoGenModel('example-ltx', {
  name: 'Example LTX',
  runtime: 'ltx2',
  supportedModes: ['text', 'image'],
  defaultFrames: 121,
  frameOptions: [121, 241],
  fpsOptions: [24],
});
const LORA = { filename: 'lora-example.safetensors', name: 'Example LoRA', loraCompatKey: 'ltx-video' };

describe('VideoGen LoRA library load state (#12040)', () => {
  beforeEach(() => {
    resetVideoGenMockState();
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MODEL]));
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([MODEL]));
    state.getModelStatus = () => ({ cached: true });
  });

  it('shows a failed library read with Retry, then the picker once the retry lands', async () => {
    state.listLorasFull.mockRejectedValueOnce(new Error('library offline'));
    await renderVideoGenPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the LoRA library — library offline');
    expect(state.loraPicker).toBeNull();

    state.availableLoras = [LORA];
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(state.loraPicker?.availableLoras).toEqual([LORA]));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(state.listLorasFull).toHaveBeenCalledTimes(2);
  });

  it('shows the empty copy for a genuinely empty library, not an error', async () => {
    await renderVideoGenPage();
    await waitFor(() => expect(state.listLorasFull).toHaveBeenCalled());
    expect(await screen.findByText(/No installed LoRAs match this model/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
