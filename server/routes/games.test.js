import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

vi.mock('../services/games/index.js', () => ({
  bindMusic: vi.fn(),
  bindSprite: vi.fn(),
  compileGameAssets: vi.fn(),
  createGame: vi.fn(),
  deleteGame: vi.fn(),
  getGame: vi.fn(),
  getGameIntegrity: vi.fn(),
  listGames: vi.fn(async () => []),
  requestGameFeedback: vi.fn(),
  unbindMusic: vi.fn(),
  unbindSprite: vi.fn(),
  updateGame: vi.fn(),
}));

import * as games from '../services/games/index.js';
import routes from './games.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/games', routes);
  app.use(errorMiddleware);
  return app;
};

describe('Game routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a managed-app-bound Game', async () => {
    games.createGame.mockResolvedValueOnce({ id: 'game-1', appId: 'app-1', name: 'Example Game' });
    const response = await request(makeApp())
      .post('/api/games')
      .send({ appId: 'app-1', name: 'Example Game' });
    expect(response.status).toBe(201);
    expect(games.createGame).toHaveBeenCalledWith({ appId: 'app-1', name: 'Example Game' });
  });

  it('validates sprite bindings before dispatch', async () => {
    const response = await request(makeApp())
      .post('/api/games/game-1/sprites')
      .send({ spriteId: '' });
    expect(response.status).toBe(400);
    expect(games.bindSprite).not.toHaveBeenCalled();
  });

  it('compiles a Game bundle', async () => {
    games.compileGameAssets.mockResolvedValueOnce({ version: 2, created: true });
    const response = await request(makeApp()).post('/api/games/game-1/compile');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ version: 2, created: true });
  });

  it('returns bundle integrity preflight details', async () => {
    games.getGameIntegrity.mockResolvedValueOnce({
      readyToCompile: false,
      issues: [{ code: 'SPRITE_ATLAS_REQUIRED' }],
    });
    const response = await request(makeApp()).get('/api/games/game-1/integrity');
    expect(response.status).toBe(200);
    expect(response.body.readyToCompile).toBe(false);
    expect(games.getGameIntegrity).toHaveBeenCalledWith('game-1');
  });

  it('passes explicit provider, model, effort, and prompt to feedback', async () => {
    games.requestGameFeedback.mockResolvedValueOnce({
      feedback: { id: 'feedback-1', text: 'Add a victory cue.' },
      game: { id: 'game-1' },
    });
    const response = await request(makeApp())
      .post('/api/games/game-1/feedback')
      .send({
        providerId: 'codex',
        model: 'gpt-5.6-terra',
        effort: 'high',
        prompt: 'Review the asset coverage.',
      });
    expect(response.status).toBe(201);
    expect(games.requestGameFeedback).toHaveBeenCalledWith('game-1', {
      providerId: 'codex',
      model: 'gpt-5.6-terra',
      effort: 'high',
      prompt: 'Review the asset coverage.',
    });
  });

  it('returns 404 for an unknown Game detail', async () => {
    games.getGame.mockResolvedValueOnce(null);
    const response = await request(makeApp()).get('/api/games/missing');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });
});
