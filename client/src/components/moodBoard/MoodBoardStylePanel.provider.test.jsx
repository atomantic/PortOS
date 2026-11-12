import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IMAGE_GEN_MODE } from '../../lib/imageGenModes';

const {
  mockProviders, mockRender, mockCompose, mockStart, mockGetJob, mockGetBoard, mockUpdateBoard, socketHandlers,
} = vi.hoisted(() => ({
  mockProviders: vi.fn(),
  mockStart: vi.fn(),
  mockGetJob: vi.fn(),
  mockGetBoard: vi.fn(),
  socketHandlers: new Map(),
  mockRender: vi.fn(async () => 'job-9'),
  mockCompose: vi.fn(),
  mockUpdateBoard: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  getProviders: (...args) => mockProviders(...args),
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

vi.mock('../ProviderModelSelector', () => ({ default: ({ selectedModel, onModelChange, availableModels }) => <select aria-label="Analysis model" value={selectedModel} onChange={event => onModelChange(event.target.value)}>{availableModels.map(model => <option key={model}>{model}</option>)}</select> }));
vi.mock('../pipeline/MediaJobThumb', () => ({ default: () => <div>rendering</div> }));

vi.mock('../../hooks/useVisionModelIds', () => ({ default: () => ({ idsByProvider: {} }) }));
vi.mock('../../hooks/useImageRenderSettings', () => ({
  default: () => ({
    imageCfg: { mode: IMAGE_GEN_MODE.GROK, modelId: 'flux', inheritedBackend: true, width: 1024, height: 1536 },
    backends: [{ id: IMAGE_GEN_MODE.GROK, label: 'Grok' }, { id: IMAGE_GEN_MODE.LOCAL, label: 'Local' }],
  }),
}));

vi.mock('../../hooks/useSingleImageRender', () => ({
  default: () => {
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


describe('mood board default execution selection', () => {
  it('uses the configured Codex TUI preset and non-first model, preserving an explicit model change', async () => {
    mockProviders.mockResolvedValue({ activeProvider: 'example-codex-tui', providers: [
      { id: 'example-claude', enabled: true, type: 'cli', command: 'claude', defaultModel: 'first-model', models: ['first-model'] },
      { id: 'example-codex-tui', enabled: true, type: 'tui', command: '/bin/codex', defaultModel: 'preferred-model', models: ['other-model'] },
    ] });
    render(<MoodBoardStylePanel board={analyzedBoard} onBoardChange={vi.fn()} />);
    await waitFor(() => expect(mockProviders).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: /Compose style prompt/i }));
    await waitFor(() => expect(mockCompose).toHaveBeenCalledWith('mb-1', { providerId: 'example-codex-tui', model: 'preferred-model' }, { silent: true }));
    await userEvent.click(screen.getByRole('button', { name: /Analysis AI:/i }));
    await userEvent.selectOptions(screen.getByLabelText('Analysis model'), 'other-model');
    await userEvent.click(screen.getByRole('button', { name: /Compose style prompt/i }));
    await waitFor(() => expect(mockCompose).toHaveBeenLastCalledWith('mb-1', { providerId: 'example-codex-tui', model: 'other-model' }, { silent: true }));
  });
});
