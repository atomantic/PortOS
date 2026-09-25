import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Routing + orchestration test: the DB-backed CRUD is covered by
// decks.db.test.js; here the services are stubbed so the casting gate, the
// stored-pin fallback and the single-card render shape are pinned.
vi.mock('../services/decks.js', () => ({
  listDecks: vi.fn(async () => []),
  getDeck: vi.fn(),
  createDeck: vi.fn(),
  updateDeck: vi.fn(),
  deleteDeck: vi.fn(),
  updateCard: vi.fn(),
  applyCardGenerations: vi.fn(async (_id, entries) => entries.length),
  addSample: vi.fn(),
  removeSample: vi.fn(),
}));
vi.mock('../services/deckStyleAnalysis.js', () => ({ analyzeDeckSample: vi.fn() }));
vi.mock('../services/deckPrompts.js', () => ({
  PROMPTS_PER_CALL: 12,
  castDeckFromUniverse: vi.fn(),
  generateDeckCardPrompts: vi.fn(),
}));
vi.mock('../services/deckRender.js', () => ({ renderDeckCards: vi.fn() }));
vi.mock('../services/deckPromptProgress.js', () => ({
  attachClient: vi.fn(() => true),
  emitPromptProgress: vi.fn(),
  finishPromptProgress: vi.fn(),
}));
vi.mock('../services/universeBuilder.js', () => ({ getUniverse: vi.fn() }));
vi.mock('./universeBuilder/shared.js', () => ({
  resolveGalleryImageOrThrow: vi.fn((f) => ({ imageFilename: f, imagePath: `/abs/${f}` })),
}));

import * as svc from '../services/decks.js';
import { analyzeDeckSample } from '../services/deckStyleAnalysis.js';
import { castDeckFromUniverse, generateDeckCardPrompts } from '../services/deckPrompts.js';
import { attachClient, emitPromptProgress, finishPromptProgress } from '../services/deckPromptProgress.js';
import { renderDeckCards } from '../services/deckRender.js';
import { getUniverse } from '../services/universeBuilder.js';
import deckRoutes from './decks.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/decks', deckRoutes);
  app.use(errorMiddleware);
  return app;
};

const D1 = randomUUID();
const C0 = randomUUID();
const C1 = randomUUID();
const CB = randomUUID();
const card = (id, extra = {}) => ({ id, key: id, name: id, prompt: '', canonRef: null, imageRefs: [], ...extra });
const deck = (extra = {}) => ({
  id: D1, name: 'Deck', kind: 'tarot', universeId: null, styleNotes: '', influences: { embrace: [], avoid: [] },
  promptLlm: { providerId: 'pinned', model: 'pinned-model', effort: 'high' },
  cards: [card(C0, { key: C0 }), card(C1, { key: C1, prompt: 'kept' }), card(CB, { key: 'back' })],
  ...extra,
});

describe('deck routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.getDeck.mockResolvedValue(deck());
    generateDeckCardPrompts.mockImplementation(async ({ onChunk }) => {
      const prompts = [{ cardId: C0, prompt: 'a fool' }];
      await onChunk?.(prompts);
      return { prompts, llm: { provider: 'p', model: 'm' } };
    });
  });

  it('validates the create body and returns 201', async () => {
    svc.createDeck.mockResolvedValueOnce({ id: 'd1' });
    const res = await request(makeApp()).post('/api/decks').send({ name: 'X', kind: 'playing', universeId: 'u1' });
    expect(res.status).toBe(201);
    expect(svc.createDeck).toHaveBeenCalledWith({ name: 'X', kind: 'playing', universeId: 'u1', description: '', seedStyleFromUniverse: true });
    expect((await request(makeApp()).post('/api/decks').send({ name: '', kind: 'playing' })).status).toBe(400);
  });

  it('analyze-sample resolves the gallery image and passes the request vision choice through', async () => {
    analyzeDeckSample.mockResolvedValueOnce({ sample: {} });
    const res = await request(makeApp()).post(`/api/decks/${D1}/analyze-sample`).send({ image: 'upload-1.png', providerId: 'vp', model: 'vm' });
    expect(res.status).toBe(200);
    expect(analyzeDeckSample).toHaveBeenCalledWith(expect.objectContaining({
      imageFilename: 'upload-1.png', imagePath: '/abs/upload-1.png', providerId: 'vp', model: 'vm', effort: undefined,
    }));
  });

  it('validates and forwards the deck-wide face orientation settings', async () => {
    svc.updateDeck.mockResolvedValueOnce(deck({ cardOrientation: 'one-way', cardOrientationPrompt: 'Keep both indices upright' }));
    const res = await request(makeApp()).patch(`/api/decks/${D1}`).send({
      cardOrientation: 'one-way', cardOrientationPrompt: 'Keep both indices upright',
    });
    expect(res.status).toBe(200);
    expect(svc.updateDeck).toHaveBeenCalledWith(D1, {
      cardOrientation: 'one-way', cardOrientationPrompt: 'Keep both indices upright',
    });
    expect((await request(makeApp()).patch(`/api/decks/${D1}`).send({ cardOrientation: 'diagonal' })).status).toBe(400);
  });

  it('generate-prompts targets only empty cards by default and skips casting without a universe', async () => {
    const res = await request(makeApp()).post(`/api/decks/${D1}/generate-prompts`).send({});
    expect(res.status).toBe(200);
    expect(castDeckFromUniverse).not.toHaveBeenCalled();
    const call = generateDeckCardPrompts.mock.calls[0][0];
    expect(call.targets.map((c) => c.id)).toEqual([C0, CB]);
    expect(call.universe).toBeNull();
    // The deck's stored pin drives the run when the request names nothing.
    expect(call).toMatchObject({ providerId: 'pinned', model: 'pinned-model', effort: 'high' });
    expect(svc.applyCardGenerations).toHaveBeenCalledWith(D1, [{ cardId: C0, prompt: 'a fool' }]);
    expect(res.body).toMatchObject({ written: 1, requested: 2, cast: 0 });
  });

  it('generate-prompts casts a universe-linked deck first and applies only new assignments', async () => {
    const linked = deck({ universeId: 'u1', cards: [card(C0, { key: C0 }), card(C1, { key: C1, canonRef: { kind: 'character', id: 'c9', name: 'Kept' } }), card(CB, { key: 'back' })] });
    svc.getDeck.mockResolvedValue(linked);
    getUniverse.mockResolvedValue({ id: 'u1', characters: [] });
    castDeckFromUniverse.mockResolvedValueOnce({
      assignments: [
        { cardId: C0, canonRef: { kind: 'character', id: 'c1', name: 'Hero' } },
        { cardId: C1, canonRef: { kind: 'character', id: 'c2', name: 'Other' } },
      ],
      llm: {},
    });
    const res = await request(makeApp()).post(`/api/decks/${D1}/generate-prompts`).send({ overwrite: true, providerId: 'p9' });
    expect(res.status).toBe(200);
    // A per-call provider switch drops the pinned model/effort (they belong to the other provider).
    expect(castDeckFromUniverse).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'p9', model: undefined, effort: undefined, universe: { id: 'u1', characters: [] } }));
    // The prompt pass sees the freshly cast card without a second deck read.
    expect(generateDeckCardPrompts.mock.calls[0][0].roster.find((c) => c.id === C0).canonRef).toEqual({ kind: 'character', id: 'c1', name: 'Hero' });
    expect(svc.getDeck).toHaveBeenCalledTimes(2);
    // The already-cast card keeps its assignment; only the uncast one is written.
    expect(svc.applyCardGenerations.mock.calls[0][1]).toEqual([{ cardId: C0, canonRef: { kind: 'character', id: 'c1', name: 'Hero' } }]);
    expect(res.body.cast).toBe(2);
  });

  it('generate-prompts 400s when nothing is left to write', async () => {
    svc.getDeck.mockResolvedValue(deck({ cards: [card(C1, { key: C1, prompt: 'kept' })] }));
    const res = await request(makeApp()).post(`/api/decks/${D1}/generate-prompts`).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DECK_NO_PROMPT_TARGETS');
    expect(generateDeckCardPrompts).not.toHaveBeenCalled();
  });

  it('generate-prompts streams start/chunk/complete progress frames', async () => {
    const res = await request(makeApp()).post(`/api/decks/${D1}/generate-prompts`).send({});
    expect(res.status).toBe(200);
    expect(emitPromptProgress).toHaveBeenCalledWith(D1, expect.objectContaining({ type: 'start', requested: 2 }));
    expect(emitPromptProgress).toHaveBeenCalledWith(D1, expect.objectContaining({
      type: 'chunk', chunk: 1, written: 1, requested: 2, keys: [C0],
    }));
    expect(finishPromptProgress).toHaveBeenCalledWith(D1, expect.objectContaining({
      type: 'complete', written: 1, requested: 2,
    }));
  });

  it('generate-prompts finishes with an error frame when the run throws', async () => {
    generateDeckCardPrompts.mockRejectedValueOnce(new Error('model blew up'));
    const res = await request(makeApp()).post(`/api/decks/${D1}/generate-prompts`).send({});
    expect(res.status).toBe(500);
    expect(finishPromptProgress).toHaveBeenCalledWith(D1, expect.objectContaining({ type: 'error' }));
  });

  it('generate-prompts/progress attaches the deck channel', async () => {
    // The real handler holds the SSE stream open; end it from the mock so
    // the request settles.
    attachClient.mockImplementationOnce((_id, res) => { res.status(200).end(); return true; });
    const res = await request(makeApp()).get(`/api/decks/${D1}/generate-prompts/progress`);
    expect(attachClient).toHaveBeenCalledWith(D1, expect.anything());
    expect(res.status).toBe(200);
  });

  it('single-card render narrows the batch to that card', async () => {
    renderDeckCards.mockResolvedValueOnce({ mode: 'local', jobs: [], skipped: 0 });
    const res = await request(makeApp()).post(`/api/decks/${D1}/cards/${C0}/render`).send({ mode: 'local' });
    expect(res.status).toBe(200);
    expect(renderDeckCards).toHaveBeenCalledWith(D1, { mode: 'local', cardIds: [C0] });
    expect((await request(makeApp()).post(`/api/decks/${D1}/render`).send({ onlyMissing: 'yes' })).status).toBe(400);
  });
});
