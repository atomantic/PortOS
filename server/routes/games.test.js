import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

vi.mock('../services/games/index.js', () => ({
  bindArtwork: vi.fn(),
  bindMusic: vi.fn(),
  bindSprite: vi.fn(),
  compileGameAssets: vi.fn(),
  createGame: vi.fn(),
  deleteGame: vi.fn(),
  getGame: vi.fn(),
  getGameIntegrity: vi.fn(),
  listGames: vi.fn(async () => []),
  publishGameArtwork: vi.fn(),
  requestGameFeedback: vi.fn(),
  unbindMusic: vi.fn(),
  unbindArtwork: vi.fn(),
  unbindSprite: vi.fn(),
  updateArtwork: vi.fn(),
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

  it('GET / returns the plain array by default', async () => {
    games.listGames.mockResolvedValueOnce([{ id: 'game-1', name: 'Example Game' }]);
    const response = await request(makeApp()).get('/api/games');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ id: 'game-1', name: 'Example Game' }]);
  });

  it('GET / returns a bounded envelope when pagination is requested', async () => {
    games.listGames.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({ id: `game-${i}`, name: `G${i}` }))
    );
    const response = await request(makeApp()).get('/api/games?limit=2&offset=1');
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(2);
    expect(response.body.items[0].id).toBe('game-1');
    expect(response.body.total).toBe(5);
    expect(response.body.limit).toBe(2);
    expect(response.body.offset).toBe(1);
  });

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

  it('updates a Game name via PATCH', async () => {
    games.updateGame.mockResolvedValueOnce({ id: 'game-1', appId: 'app-1', name: 'Renamed Game' });
    const response = await request(makeApp())
      .patch('/api/games/game-1')
      .send({ name: 'Renamed Game' });
    expect(response.status).toBe(200);
    expect(response.body.name).toBe('Renamed Game');
    expect(games.updateGame).toHaveBeenCalledWith('game-1', { name: 'Renamed Game' });
  });

  it('rejects a PATCH with no fields', async () => {
    const response = await request(makeApp()).patch('/api/games/game-1').send({});
    expect(response.status).toBe(400);
    expect(games.updateGame).not.toHaveBeenCalled();
  });

  it('deletes a Game', async () => {
    games.deleteGame.mockResolvedValueOnce({ ok: true });
    const response = await request(makeApp()).delete('/api/games/game-1');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(games.deleteGame).toHaveBeenCalledWith('game-1');
  });

  it('unbinds a sprite from a Game', async () => {
    games.unbindSprite.mockResolvedValueOnce({ id: 'game-1', spriteBindings: [] });
    const response = await request(makeApp()).delete('/api/games/game-1/sprites/sprite-1');
    expect(response.status).toBe(200);
    expect(games.unbindSprite).toHaveBeenCalledWith('game-1', 'sprite-1');
  });

  it('binds music to a Game', async () => {
    games.bindMusic.mockResolvedValueOnce({ id: 'game-1', musicBindings: [{ id: 'music-1', trackId: 'track-1' }] });
    const response = await request(makeApp())
      .post('/api/games/game-1/music')
      .send({ trackId: 'track-1' });
    expect(response.status).toBe(201);
    expect(games.bindMusic).toHaveBeenCalledWith('game-1', { trackId: 'track-1' });
  });

  it('rejects a music binding missing trackId', async () => {
    const response = await request(makeApp())
      .post('/api/games/game-1/music')
      .send({ trackId: '' });
    expect(response.status).toBe(400);
    expect(games.bindMusic).not.toHaveBeenCalled();
  });

  it('unbinds music from a Game', async () => {
    games.unbindMusic.mockResolvedValueOnce({ id: 'game-1', musicBindings: [] });
    const response = await request(makeApp()).delete('/api/games/game-1/music/music-1');
    expect(response.status).toBe(200);
    expect(games.unbindMusic).toHaveBeenCalledWith('game-1', 'music-1');
  });

  it('binds and publishes role-specific gallery artwork', async () => {
    const updated = { id: 'game-1', artworkBindings: [{ id: 'artwork-1' }] };
    games.bindArtwork.mockResolvedValueOnce(updated);
    const binding = {
      imageFilename: 'title-key-art.png',
      label: 'Title Key Art',
      role: 'title-key-art',
      destinationPath: 'game/assets/art/title/title-key-art.png',
    };
    const bindResponse = await request(makeApp())
      .post('/api/games/game-1/artwork')
      .send(binding);
    expect(bindResponse.status).toBe(201);
    expect(games.bindArtwork).toHaveBeenCalledWith('game-1', binding);

    games.publishGameArtwork.mockResolvedValueOnce({
      game: updated,
      publication: { bindingId: 'artwork-1', wrote: true },
    });
    const publishResponse = await request(makeApp())
      .post('/api/games/game-1/artwork/artwork-1/publish')
      .send({});
    expect(publishResponse.status).toBe(200);
    expect(games.publishGameArtwork).toHaveBeenCalledWith('game-1', 'artwork-1', {});
  });

  it('accepts a game logo as managed interface artwork', async () => {
    const binding = {
      imageFilename: 'example-game-logo.png',
      label: 'Example Game Logo',
      role: 'game-logo',
      destinationPath: 'game/assets/art/ui/branding/example-game-logo.png',
    };
    games.bindArtwork.mockResolvedValueOnce({ id: 'game-1', artworkBindings: [binding] });

    const response = await request(makeApp())
      .post('/api/games/game-1/artwork')
      .send(binding);

    expect(response.status).toBe(201);
    expect(games.bindArtwork).toHaveBeenCalledWith('game-1', binding);
  });

  it('rejects artwork destinations that escape the managed repository', async () => {
    const response = await request(makeApp())
      .post('/api/games/game-1/artwork')
      .send({
        imageFilename: 'title.png',
        label: 'Title',
        role: 'title-key-art',
        destinationPath: '../outside.png',
      });
    expect(response.status).toBe(400);
    expect(games.bindArtwork).not.toHaveBeenCalled();
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

  it('404s the integrity preflight for a game that does not exist', async () => {
    games.getGameIntegrity.mockResolvedValueOnce(null);
    const response = await request(makeApp()).get('/api/games/missing/integrity');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
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
