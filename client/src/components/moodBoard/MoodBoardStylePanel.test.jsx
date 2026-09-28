import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IMAGE_GEN_MODE } from '../../lib/imageGenModes';
import { BOARD_POSTER_SIZE } from '../../lib/moodBoardAnalysis';

const {
  mockRender, mockCompose, mockPrompt, mockUpdateItem, mockUpdateBoard,
} = vi.hoisted(() => ({
  mockRender: vi.fn(async () => 'job-9'),
  mockCompose: vi.fn(),
  mockPrompt: vi.fn(),
  mockUpdateItem: vi.fn(),
  mockUpdateBoard: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  promptFromMedia: (...args) => mockPrompt(...args),
  composeMoodBoardPrompt: (...args) => mockCompose(...args),
  updateMoodBoardItem: (...args) => mockUpdateItem(...args),
  updateMoodBoard: (...args) => mockUpdateBoard(...args),
}));

vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../ProviderModelSelector', () => ({ default: () => <div>provider</div> }));
vi.mock('../pipeline/MediaJobThumb', () => ({ default: () => <div>rendering</div> }));

vi.mock('../../hooks/useVisionModelIds', () => ({ default: () => ({ idsByProvider: {} }) }));
vi.mock('../../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [{ id: 'vision-1', name: 'Vision', type: 'api', enabled: true }],
    selectedProviderId: 'vision-1',
    selectedModel: 'vlm',
    availableModels: ['vlm'],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    loading: false,
  }),
}));
vi.mock('../../hooks/useImageRenderSettings', () => ({
  default: () => ({
    imageCfg: { mode: IMAGE_GEN_MODE.GROK, modelId: 'flux', inheritedBackend: true, width: 1024, height: 1536 },
    backends: [{ id: IMAGE_GEN_MODE.GROK, label: 'Grok' }, { id: IMAGE_GEN_MODE.LOCAL, label: 'Local' }],
  }),
}));

let lastRenderOpts = null;
vi.mock('../../hooks/useSingleImageRender', () => ({
  default: (opts) => {
    lastRenderOpts = opts;
    return { jobId: null, render: mockRender, handleComplete: vi.fn() };
  },
}));

import MoodBoardStylePanel from './MoodBoardStylePanel';

const analyzedBoard = {
  id: 'mb-1',
  items: [{ id: 'a', type: 'image', mediaKey: 'image:a.png', analysis: { prompt: 'ink wash' } }],
  style: {
    prompt: 'dusty ink wash',
    negativePrompt: 'gloss',
    rationale: 'tactile',
    analyzedItemCount: 1,
    composedAt: '2026-08-14T00:00:00.000Z',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  lastRenderOpts = null;
  mockCompose.mockResolvedValue({
    ...analyzedBoard,
    style: { ...analyzedBoard.style, prompt: 'composed ink' },
  });
  mockPrompt.mockResolvedValue({ imagePrompt: 'a pin in ink', imageNegativePrompt: 'gloss', providerId: 'vision-1', model: 'vlm' });
  mockUpdateItem.mockImplementation(async (_id, _itemId, patch) => ({
    id: 'b', type: 'image', mediaKey: 'image:b.png', analysis: patch.analysis,
  }));
  mockUpdateBoard.mockImplementation(async (_id, patch) => ({ ...analyzedBoard, ...patch }));
});

describe('MoodBoardStylePanel', () => {
  it('composes from saved analyses without running prompt-from-media again', async () => {
    const onBoardChange = vi.fn();
    render(<MoodBoardStylePanel board={analyzedBoard} onBoardChange={onBoardChange} />);
    expect(screen.queryByRole('button', { name: 'Analyze board' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Compose board style' }));
    await waitFor(() => expect(mockCompose).toHaveBeenCalledWith('mb-1', { providerId: 'vision-1', model: 'vlm' }, { silent: true }));
    expect(mockPrompt).not.toHaveBeenCalled();
    expect(onBoardChange).toHaveBeenCalledWith(expect.objectContaining({
      style: expect.objectContaining({ prompt: 'composed ink' }),
    }));
  });

  it('analyzes unread gallery pins, then composes the board style', async () => {
    const board = {
      id: 'mb-1',
      items: [{ id: 'b', type: 'image', mediaKey: 'image:b.png' }],
    };
    render(<MoodBoardStylePanel board={board} onBoardChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Compose board style' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Analyze board' }));
    await waitFor(() => expect(mockCompose).toHaveBeenCalled());
    expect(mockPrompt).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: 'image',
      filename: 'b.png',
      targets: ['image'],
      providerId: 'vision-1',
    }), { silent: true });
    expect(mockUpdateItem).toHaveBeenCalledWith('mb-1', 'b', expect.objectContaining({
      analysis: expect.objectContaining({ prompt: 'a pin in ink' }),
    }), { silent: true });
  });

  it('renders the poster on the selected image service and pins the filename', async () => {
    const onBoardChange = vi.fn();
    render(<MoodBoardStylePanel board={analyzedBoard} onBoardChange={onBoardChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Generate poster' }));
    await waitFor(() => expect(mockRender).toHaveBeenCalledWith(expect.objectContaining({
      mode: IMAGE_GEN_MODE.GROK,
      inheritedBackend: false,
      width: BOARD_POSTER_SIZE.width,
      height: BOARD_POSTER_SIZE.height,
      modelId: null,
    })));
    await lastRenderOpts.onComplete('poster.png');
    expect(mockUpdateBoard).toHaveBeenCalledWith('mb-1', { posterImageRef: 'poster.png' }, { silent: true });
    expect(onBoardChange).toHaveBeenCalled();
  });

  it('shows a saved poster', () => {
    render(<MoodBoardStylePanel board={{ ...analyzedBoard, posterImageRef: 'poster.png' }} onBoardChange={vi.fn()} />);
    expect(screen.getByAltText('Board poster').getAttribute('src')).toBe('/data/images/poster.png');
    expect(screen.getByRole('button', { name: 'Regenerate poster' })).toBeEnabled();
  });
});
