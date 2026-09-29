import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IMAGE_GEN_MODE } from '../../lib/imageGenModes';
import { BOARD_POSTER_SIZE } from '../../lib/moodBoardAnalysis';

const {
  mockRender, mockCompose, mockStart, mockGetJob, mockGetBoard, mockUpdateBoard, socketHandlers,
} = vi.hoisted(() => ({
  mockStart: vi.fn(),
  mockGetJob: vi.fn(),
  mockGetBoard: vi.fn(),
  socketHandlers: new Map(),
  mockRender: vi.fn(async () => 'job-9'),
  mockCompose: vi.fn(),
  mockUpdateBoard: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  composeMoodBoardPrompt: (...args) => mockCompose(...args),
  startMoodBoardAnalyze: (...args) => mockStart(...args),
  getMoodBoardAnalyze: (...args) => mockGetJob(...args),
  getMoodBoard: (...args) => mockGetBoard(...args),
  updateMoodBoard: (...args) => mockUpdateBoard(...args),
}));

vi.mock('../../services/socket', () => ({
  default: {
    on: (evt, fn) => socketHandlers.set(evt, fn),
    off: (evt) => socketHandlers.delete(evt),
  },
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
  mockGetJob.mockResolvedValue(null);
  mockGetBoard.mockResolvedValue(analyzedBoard);
  mockStart.mockResolvedValue({ boardId: 'mb-1', status: 'running', phase: 'preparing', total: 0, done: 0 });
  socketHandlers.clear();
  mockUpdateBoard.mockImplementation(async (_id, patch) => ({ ...analyzedBoard, ...patch }));
});

describe('MoodBoardStylePanel', () => {
  it('composes from saved analyses without running prompt-from-media again', async () => {
    const onBoardChange = vi.fn();
    render(<MoodBoardStylePanel board={analyzedBoard} onBoardChange={onBoardChange} />);
    expect(screen.queryByRole('button', { name: 'Analyze board' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Compose board style' }));
    await waitFor(() => expect(mockCompose).toHaveBeenCalledWith('mb-1', { providerId: 'vision-1', model: 'vlm' }, { silent: true }));
    expect(mockStart).not.toHaveBeenCalled();
    expect(onBoardChange).toHaveBeenCalledWith(expect.objectContaining({
      style: expect.objectContaining({ prompt: 'composed ink' }),
    }));
  });

  it('starts the server-side analyze job and shows its progress', async () => {
    const board = { id: 'mb-1', items: [{ id: 'b', type: 'image', mediaKey: 'image:b.png' }] };
    render(<MoodBoardStylePanel board={board} onBoardChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Compose board style' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Analyze board' }));
    expect(mockStart).toHaveBeenCalledWith('mb-1', { providerId: 'vision-1', model: 'vlm' }, { silent: true });
    await act(async () => {
      socketHandlers.get('mood-board:analyze')({ boardId: 'mb-1', status: 'running', phase: 'analyzing', total: 4, done: 1 });
    });
    expect(screen.getByRole('button', { name: /Analyzing 2 of 4/ })).toBeDisabled();
  });

  it('picks the run back up after navigating away and returning', async () => {
    mockGetJob.mockResolvedValue({ boardId: 'mb-1', status: 'running', phase: 'analyzing', total: 5, done: 2 });
    const board = { id: 'mb-1', items: [{ id: 'b', type: 'image', mediaKey: 'image:b.png' }] };
    render(<MoodBoardStylePanel board={board} onBoardChange={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /Analyzing 3 of 5/ })).toBeDisabled();
    expect(mockStart).not.toHaveBeenCalled();
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
