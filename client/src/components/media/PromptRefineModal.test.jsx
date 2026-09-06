import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PromptRefineModal from './PromptRefineModal';
import { normalizeVideo } from './normalize';
import * as api from '../../services/api';

vi.mock('../../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [{ id: 'example-provider', name: 'Example Provider', enabled: true, defaultModel: 'example-model' }],
    selectedProviderId: 'example-provider',
    selectedModel: 'example-model',
    availableModels: ['example-model'],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    loading: false,
  }),
}));

vi.mock('../../services/api', () => ({
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
  refineMediaPrompt: vi.fn(),
}));

const videoRecord = (tiling) => normalizeVideo({
  id: 'example-video',
  filename: 'example-video.mp4',
  prompt: 'a paper boat',
  modelId: 'example-model',
  tiling,
});

describe('PromptRefineModal video queue payload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.refineMediaPrompt).mockResolvedValue({
      prompt: 'a paper boat drifting downstream',
      negativePrompt: '',
      rationale: 'Added motion.',
    });
    vi.mocked(api.generateVideo).mockResolvedValue({ position: 1 });
  });

  async function refineAndQueue(item) {
    render(<PromptRefineModal item={item} open onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Feedback'), { target: { value: 'Add motion' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refine Prompt' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Queue Render' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Queue Render' }));
    await waitFor(() => expect(api.generateVideo).toHaveBeenCalled());
  }

  it('omits legacy boolean tiling before queueing a refined saved video', async () => {
    await refineAndQueue(videoRecord(true));

    expect(api.generateVideo).toHaveBeenCalledWith(expect.not.objectContaining({ tiling: true }));
    expect(api.generateVideo.mock.calls[0][0]).not.toHaveProperty('tiling');
  });

  it('retains a recognized tiling mode in the queue payload', async () => {
    await refineAndQueue(videoRecord('spatial'));

    expect(api.generateVideo).toHaveBeenCalledWith(expect.objectContaining({ tiling: 'spatial' }));
  });
});
