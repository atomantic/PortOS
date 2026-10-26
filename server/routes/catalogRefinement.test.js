import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const state = vi.hoisted(() => ({ run: vi.fn(), get: vi.fn() }));
vi.mock('../services/promptRunner.js', () => ({
  resolveProviderAndModel: async () => ({ provider: { id: 'chosen', type: 'api' }, selectedModel: 'model' }),
  assertProvider: vi.fn(), runPromptThroughProvider: state.run,
}));
vi.mock('../services/catalogDB/ingredients.js', () => ({ getIngredient: state.get }));
vi.mock('../services/catalogPrimitives.js', () => ({
  getPrimitiveContext: async () => ({ owner: { refId: 'world' } }), setPrimitiveOwner: vi.fn(), forkPrimitive: vi.fn(),
}));
vi.mock('../services/universeBuilder/crud.js', () => ({ getUniverse: async () => ({ name: 'World', styleNotes: 'Watercolor' }) }));
const { default: router } = await import('./catalogPrimitives.js');
const app = express(); app.use(express.json()); app.use('/ingredients/:id', router); app.use(errorMiddleware);
const input = { draft: { physicalDescription: 'Original' }, messages: [{ role: 'user', content: '  Try silver wings  ' }], providerId: 'chosen', model: 'model', effort: 'high' };
beforeEach(() => {
  vi.clearAllMocks();
  state.get.mockResolvedValue({ id: 'cast', type: 'character', name: 'Courier' });
  state.run.mockResolvedValue({ text: JSON.stringify({ reply: 'Try these wings.', draft: { physicalDescription: 'Silver wings' } }), runId: 'run' });
});
describe('catalog redesign conversation boundary', () => {
  it('composes without calling a provider, then sends exact feedback, context and effort and returns an unsaved proposal', async () => {
    const preview = await request(app).post('/ingredients/cast/refine/compose').send(input);
    expect(preview.status).toBe(200);
    expect(state.run).not.toHaveBeenCalled();
    const response = await request(app).post('/ingredients/cast/refine').send(input);
    expect(response.status).toBe(200);
    expect(response.body.draft).toEqual({ physicalDescription: 'Silver wings' });
    expect(state.run).toHaveBeenCalledWith(expect.objectContaining({ effort: 'high', model: 'model', allowFallback: false, prompt: preview.body.sentPrompt }));
    expect(response.body.sentPrompt).toContain('  Try silver wings  ');
    expect(response.body.sentPrompt).toContain('Watercolor');
  });
  it('refuses runtime fields, malformed inputs and overflowing history before execution', async () => {
    for (const body of [{ ...input, draft: { voiceId: 'overwrite' } }, { ...input, messages: [] }, { ...input, messages: Array(41).fill(input.messages[0]) }]) {
      expect((await request(app).post('/ingredients/cast/refine').send(body)).status).toBe(400);
    }
    expect(state.run).not.toHaveBeenCalled();
  });
  it('rejects provider field injection and over-limit proposals without truncation', async () => {
    for (const draft of [{ physicalDescription: 'valid', voiceId: 'injected' }, { physicalDescription: 'x'.repeat(2001) }]) {
      state.run.mockResolvedValue({ text: JSON.stringify({ reply: 'Proposal', draft }) });
      expect((await request(app).post('/ingredients/cast/refine').send(input)).status).toBe(502);
    }
  });
  it.each(['place', 'object'])('supports %s redesigns', async type => {
    state.get.mockResolvedValue({ id: type, type, name: type });
    state.run.mockResolvedValue({ text: JSON.stringify({ reply: 'Revised', draft: { description: 'New design' } }) });
    const response = await request(app).post(`/ingredients/${type}/refine`).send({ ...input, draft: { description: 'Old design' } });
    expect(response.status).toBe(200);
    expect(response.body.draft.description).toBe('New design');
  });
});
