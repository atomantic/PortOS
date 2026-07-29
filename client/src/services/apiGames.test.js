import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./apiCore.js', () => ({
  request: vi.fn(),
}));

let request;
let api;

beforeEach(async () => {
  vi.resetModules();
  ({ request } = await import('./apiCore.js'));
  api = await import('./apiGames.js');
  request.mockReset();
  request.mockResolvedValue({});
});

describe('apiGames', () => {
  it('forwards silent options without clobbering a sprite bind request', async () => {
    await api.bindGameSprite('game/1', 'sprite/1', { silent: true });
    expect(request).toHaveBeenCalledWith('/games/game%2F1/sprites', {
      method: 'POST',
      body: JSON.stringify({ spriteId: 'sprite/1' }),
      silent: true,
    });
  });

  it('posts arbitrary provider/model/effort feedback', async () => {
    const body = {
      providerId: 'codex',
      model: 'gpt-5.6-terra',
      effort: 'high',
      prompt: 'Review this bundle.',
    };
    await api.requestGameFeedback('game-1', body, { silent: true });
    expect(request).toHaveBeenCalledWith('/games/game-1/feedback', {
      method: 'POST',
      body: JSON.stringify(body),
      silent: true,
    });
  });

  it('uses a POST for deterministic compilation', async () => {
    await api.compileGameAssets('game-1');
    expect(request).toHaveBeenCalledWith('/games/game-1/compile', { method: 'POST' });
  });

  it('loads the integrity preflight silently', async () => {
    await api.getGameIntegrity('game/1', { silent: true });
    expect(request).toHaveBeenCalledWith('/games/game%2F1/integrity', { silent: true });
  });
});
