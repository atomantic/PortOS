import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  game: null,
}));

vi.mock('./records.js', () => ({
  GAME_HISTORY_LIMIT: 50,
  getGame: vi.fn(async () => state.game),
  mutateGame: vi.fn(async (_id, mutator) => {
    state.game = await mutator(state.game);
    return state.game;
  }),
}));

vi.mock('../providers.js', () => ({
  getProviderById: vi.fn(async () => ({
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    type: 'cli',
    args: [],
    enabled: true,
    defaultModel: 'gpt-5.6-terra',
  })),
}));

vi.mock('../../lib/promptRunner.js', () => ({
  resolveEffectiveModel: vi.fn((_provider, model) => model),
  runPromptThroughProvider: vi.fn(async () => ({
    text: 'Add a victory cue.',
    provider: { id: 'codex' },
    model: 'gpt-5.6-terra',
  })),
}));

vi.mock('../apps.js', () => ({
  getAppById: vi.fn(async () => ({ id: 'app-1', name: 'Example App', type: 'godot' })),
}));

vi.mock('../sprites/records.js', () => ({
  getRecord: vi.fn(async (id) => ({ id, name: 'Example Hero', kind: 'character', status: 'ready' })),
}));

vi.mock('../tracks/index.js', () => ({
  getTrack: vi.fn(async (id) => ({ id, title: 'Example Theme', audioFilename: 'theme.ogg' })),
}));

import { runPromptThroughProvider } from '../../lib/promptRunner.js';
import { getProviderById } from '../providers.js';
import { requestGameFeedback } from './feedback.js';

describe('requestGameFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.game = {
      id: 'game-1',
      name: 'Example Game',
      appId: 'app-1',
      spriteBindings: [{ spriteId: 'hero' }],
      musicBindings: [{ id: 'music-1', trackId: 'theme' }],
      compiledManifest: null,
      feedbackHistory: [],
    };
  });

  it('runs the exact selected provider/model/effort and persists the response', async () => {
    const result = await requestGameFeedback('game-1', {
      providerId: 'codex',
      model: 'gpt-5.6-terra',
      effort: 'high',
      prompt: 'Review the bundle.',
    });
    expect(getProviderById).toHaveBeenCalledWith('codex');
    expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: expect.objectContaining({
        id: 'codex',
        args: ['-c', 'model_reasoning_effort=high'],
      }),
      model: 'gpt-5.6-terra',
      source: 'game-asset-feedback',
    }));
    expect(result.feedback).toEqual(expect.objectContaining({
      text: 'Add a victory cue.',
      providerId: 'codex',
      model: 'gpt-5.6-terra',
      effort: 'high',
    }));
    expect(result.game.feedbackHistory).toHaveLength(1);
  });

  it('does not silently substitute a different provider', async () => {
    getProviderById.mockResolvedValueOnce(null);
    await expect(requestGameFeedback('game-1', {
      providerId: 'missing',
      model: 'example-model',
      prompt: 'Review the bundle.',
    })).rejects.toMatchObject({ status: 404, code: 'PROVIDER_NOT_FOUND' });
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
  });
});
