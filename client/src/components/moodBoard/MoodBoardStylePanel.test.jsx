import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
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
    expect(screen.queryByRole('button', { name: /^Analyze/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Compose style prompt' }));
    await waitFor(() => expect(mockCompose).toHaveBeenCalledWith('mb-1', { providerId: 'vision-1', model: 'vlm' }, { silent: true }));
    expect(mockStart).not.toHaveBeenCalled();
    expect(onBoardChange).toHaveBeenCalledWith(expect.objectContaining({
      style: expect.objectContaining({ prompt: 'composed ink' }),
    }));
  });

  it('starts the server-side analyze job and shows its progress', async () => {
    const board = { id: 'mb-1', items: [{ id: 'b', type: 'image', mediaKey: 'image:b.png' }] };
    render(<MoodBoardStylePanel board={board} onBoardChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Compose style prompt' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Analyze 1 new' }));
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

  it('keeps a completion pushed before the start response instead of restoring running state', async () => {
    let finish;
    mockStart.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const board = { id: 'mb-1', items: [{ id: 'b', type: 'image', mediaKey: 'image:b.png' }] };
    render(<MoodBoardStylePanel board={board} onBoardChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Analyze 1 new' }));
    await act(async () => socketHandlers.get('mood-board:analyze')({ boardId: 'mb-1', status: 'done' }));
    await act(async () => finish({ boardId: 'mb-1', status: 'running', phase: 'preparing', total: 0, done: 0 }));
    expect(screen.getByRole('button', { name: 'Analyze 1 new' })).toBeEnabled();
  });

  it('keeps a previous board start response out of the newly selected board', async () => {
    let finish;
    mockStart.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const board = { id: 'mb-1', items: [{ id: 'b', type: 'image', mediaKey: 'image:b.png' }] };
    const onBoardChange = vi.fn();
    const { rerender } = render(<MoodBoardStylePanel board={board} onBoardChange={onBoardChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Analyze 1 new' }));
    rerender(<MoodBoardStylePanel board={{ ...board, id: 'mb-2' }} onBoardChange={onBoardChange} />);
    expect(screen.getByRole('button', { name: 'Analyze 1 new' })).toBeEnabled();
    await act(async () => finish({ boardId: 'mb-1', status: 'running', phase: 'preparing', total: 0, done: 0 }));
    expect(screen.getByRole('button', { name: 'Analyze 1 new' })).toBeEnabled();
    rerender(<MoodBoardStylePanel board={board} onBoardChange={onBoardChange} />);
    expect(screen.getByRole('button', { name: 'Analyze 1 new' })).toBeEnabled();
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

  it('keeps a saved negative prompt on screen while it is cleared', async () => {
    render(<MoodBoardStylePanel board={analyzedBoard} onBoardChange={vi.fn()} />);
    const field = screen.getByLabelText('Negative prompt (optional)');
    field.focus();
    fireEvent.change(field, { target: { value: '' } });
    expect(screen.getByLabelText('Negative prompt (optional)')).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(screen.getByRole('button', { name: 'Save style' })).toBeEnabled();
  });

  it('shows a saved poster', () => {
    render(<MoodBoardStylePanel board={{ ...analyzedBoard, posterImageRef: 'poster.png' }} onBoardChange={vi.fn()} />);
    expect(screen.getByAltText('Board poster').getAttribute('src')).toBe('/data/images/poster.png');
    expect(screen.getByRole('button', { name: 'Regenerate poster' })).toBeEnabled();
  });

  it('opens the poster in a preview modal when clicked', async () => {
    render(<MoodBoardStylePanel board={{ ...analyzedBoard, posterImageRef: 'poster.png' }} onBoardChange={vi.fn()} />);
    expect(screen.queryByAltText('Board poster preview')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Preview board poster' }));
    expect(screen.getByAltText('Board poster preview').getAttribute('src')).toBe('/data/images/poster.png');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByAltText('Board poster preview')).toBeNull();
  });
});


it('starts Make complete with the selected renderer and restores server-side image progress', async () => {
  const { unmount } = render(<MoodBoardStylePanel board={analyzedBoard} onBoardChange={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Make complete' }));
  expect(mockStart).toHaveBeenCalledWith('mb-1', { providerId: 'vision-1', model: 'vlm', render: { mode: IMAGE_GEN_MODE.GROK } }, { silent: true });
  expect(mockRender).not.toHaveBeenCalled();
  unmount();
  mockGetJob.mockResolvedValue({ boardId: 'mb-1', makeComplete: true, status: 'running', phase: 'rendering', total: 1, done: 1 });
  render(<MoodBoardStylePanel board={analyzedBoard} onBoardChange={vi.fn()} />);
  expect(await screen.findByRole('button', { name: 'Creating main board image…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Compose style prompt' })).toBeDisabled();
  expect(screen.getByLabelText('Style prompt')).toBeDisabled();
  expect(screen.getByLabelText('Negative prompt (optional)')).toBeDisabled();
});

it('retains a failed completion reason on return and protects unsaved style edits', async () => {
  mockGetJob.mockResolvedValue({ boardId: 'mb-1', makeComplete: true, status: 'failed', error: 'Renderer unavailable' });
  render(<MoodBoardStylePanel board={analyzedBoard} onBoardChange={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Renderer unavailable');
  fireEvent.change(screen.getByLabelText('Style prompt'), { target: { value: 'my unsaved look' } });
  expect(screen.getByRole('button', { name: 'Make complete' })).toBeDisabled();
});


it('recovers a completion missed while disconnected', async () => {
  mockGetJob.mockResolvedValue({ boardId: 'mb-1', makeComplete: true, status: 'running', phase: 'rendering', total: 1, done: 1 });
  const onBoardChange = vi.fn();
  render(<MoodBoardStylePanel board={analyzedBoard} onBoardChange={onBoardChange} />);
  expect(await screen.findByRole('button', { name: 'Creating main board image…' })).toBeDisabled();
  mockGetJob.mockResolvedValue({ boardId: 'mb-1', makeComplete: true, status: 'done', phase: null });
  mockGetBoard.mockResolvedValue({ ...analyzedBoard, posterImageRef: 'complete.png' });
  await act(async () => socketHandlers.get('connect')());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Make complete' })).not.toBeDisabled());
  expect(onBoardChange).toHaveBeenCalledWith(expect.objectContaining({ posterImageRef: 'complete.png' }));
});


it('hides Make complete for a completed board and restores it for missing or newer work', () => {
  const complete = { ...analyzedBoard, posterImageRef: 'poster.png' };
  const { rerender } = render(<MoodBoardStylePanel board={complete} onBoardChange={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Make complete' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Regenerate poster' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Compose style prompt' })).toBeEnabled();

  for (const board of [
    { ...complete, posterImageRef: null },
    { ...complete, items: [{ id: 'caption-only', type: 'image', mediaKey: 'image:caption.png', caption: 'generation prompt' }] },
    { ...complete, style: null },
    { ...complete, items: [...complete.items, { id: 'new', type: 'image', mediaKey: 'image:new.png' }] },
    { ...complete, items: complete.items.map(item => ({ ...item, analysis: { ...item.analysis, analyzedAt: '2026-08-15T00:00:00.000Z' } })) },
    { ...complete, items: [] },
  ]) {
    rerender(<MoodBoardStylePanel board={board} onBoardChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Make complete' })).toBeInTheDocument();
  }
  rerender(<MoodBoardStylePanel board={complete} onBoardChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Style prompt'), { target: { value: 'edited style' } });
  expect(screen.getByRole('button', { name: 'Make complete' })).toBeDisabled();
});

it('keeps an active completion visible even when previous outputs exist', async () => {
  mockGetJob.mockResolvedValue({ boardId: 'mb-1', makeComplete: true, status: 'running', phase: 'rendering', total: 1, done: 1 });
  render(<MoodBoardStylePanel board={{ ...analyzedBoard, posterImageRef: 'previous.png' }} onBoardChange={vi.fn()} />);
  expect(await screen.findByRole('button', { name: 'Creating main board image…' })).toBeDisabled();
});

it('treats a budget-sampled composed board as complete', () => {
  render(<MoodBoardStylePanel board={{ ...analyzedBoard, posterImageRef: 'poster.png', items: [...analyzedBoard.items, { ...analyzedBoard.items[0], id: 'b' }] }} onBoardChange={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Make complete' })).toBeNull();
});

it('does not call a board with unreadable unanalyzed pins complete', () => {
  render(<MoodBoardStylePanel board={{ ...analyzedBoard, posterImageRef: 'poster.png', items: [...analyzedBoard.items, { id: 'unavailable', type: 'image', source: 'https://example.com/image.png' }] }} onBoardChange={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Make complete' })).toBeTruthy();
});
