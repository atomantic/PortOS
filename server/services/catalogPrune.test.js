import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('./promptRunner.js', () => ({ runPromptThroughProvider: vi.fn() }));
import { getProviderById } from './providers.js';
import { runPromptThroughProvider } from './promptRunner.js';
import { pruneCatalogBabble } from './catalogPrune.js';
import { catalogScrapCommitSchema } from '../lib/catalogValidation.js';

const options = { rawText: 'A traveler meets her alternate self. They argue about a lost moon.', providerId: 'example-provider', model: 'example-model', effort: 'high' };
beforeEach(() => {
  vi.clearAllMocks();
  getProviderById.mockResolvedValue({ id: options.providerId, enabled: true });
});
describe('prune brainstorm into reviewable catalog entries', () => {
  it('uses the selected provider/model/effort and produces commit-compatible distinct candidates', async () => {
    runPromptThroughProvider.mockResolvedValue({ runId: 'example-run', text: JSON.stringify({ entries: [
      { type: 'idea', name: 'Reconciliation', summary: 'A traveler learns to forgive her alternate self.', tags: ['character-journey'] },
      { type: 'scene', name: 'Moon argument', summary: '“You lost our moon.” “I set it free.”', tags: ['dialogue'] },
      { type: 'character', name: 'Traveler', summary: 'A traveler haunted by her choices.' },
      { type: 'idea', name: 'Reconciliation', summary: 'Duplicate.' },
    ] }) });
    const draft = await pruneCatalogBabble(options);
    expect(runPromptThroughProvider).toHaveBeenCalledTimes(1);
    expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({ model: options.model, effort: 'high', provider: { id: options.providerId, enabled: true }, allowFallback: false }));
    expect(draft.ideas).toHaveLength(1);
    expect(draft.scenes[0].summary).toContain('“You lost our moon.”');
    expect(draft.characters[0].physicalDescription).toContain('traveler');
    const accepted = ['character', 'place', 'object', 'idea', 'scene', 'concept'].flatMap(type => draft[`${type}s`].map(({ name, tags, ...payload }) => ({ type, name, tags, payload })));
    expect(catalogScrapCommitSchema.safeParse({ accepted }).success).toBe(true);
  });
  it('rejects malformed output and unavailable providers without accepting an empty success', async () => {
    runPromptThroughProvider.mockResolvedValue({ text: '{"entries":[{"type":"unknown","name":"Bad"}]}' });
    await expect(pruneCatalogBabble(options)).rejects.toThrow('invalid prune draft');
    getProviderById.mockResolvedValue(null);
    await expect(pruneCatalogBabble(options)).rejects.toThrow('enabled AI provider');
    expect(runPromptThroughProvider).toHaveBeenCalledTimes(1);
  });
  it('accepts an intentional empty result and refuses oversized input before calling AI', async () => {
    runPromptThroughProvider.mockResolvedValue({ text: '{"entries":[]}' });
    expect((await pruneCatalogBabble(options)).stages[0].count).toBe(0);
    await expect(pruneCatalogBabble({ ...options, rawText: 'a'.repeat(30001) })).rejects.toThrow('30,000');
    expect(runPromptThroughProvider).toHaveBeenCalledTimes(1);
  });
});
