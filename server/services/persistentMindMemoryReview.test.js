import { afterAll, describe, expect, it, vi } from 'vitest';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-mind-review-' });
vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));
vi.mock('./memoryBM25.js', () => ({ indexMemory: vi.fn(async () => {}) }));
const memory = await import('./memory.js');
const { reviewPersistentMindMemory, createPersistentMindMemory, protectPersistentMindMemory, updatePersistentMindMemory } = await import('./persistentMindContext.js');
const context = { turnId: 'turn-example', providerId: 'provider-example', model: 'model-example' };
const review = (record, verdict, extra = {}, runtime = context) => reviewPersistentMindMemory({ memoryId: record.id, expectedVersion: record.version, verdict, ...extra }, runtime);
afterAll(cleanup);

describe('mind-owned memory review service', () => {
  it('keeps prose and metrics unchanged, learns once across provider swaps, then explicitly archives', async () => {
    const source = await createPersistentMindMemory({ type: 'observation', content: 'An uncertain synthetic observation.', importance: 0.3 });
    await review(source, 'defer', { rationale: 'Perhaps retire later; this is not an archive instruction.' });
    expect(await memory.peekMemory(source.id)).toMatchObject({ content: source.content, status: 'active', importance: 0.3, accessCount: 0, version: 1 });
    const input = { lesson: '  Preserve uncertainty when learning.  ', rationale: 'Synthetic lesson.' };
    const [first, second] = await Promise.all([review(source, 'learn', input), review(source, 'learn', input)]);
    expect(first.review.lessonId).toBe(second.review.lessonId);
    const replay = await review(source, 'learn', input, { ...context, turnId: 'another-turn', providerId: 'another-provider', model: 'another-model' });
    expect(replay).toMatchObject({ duplicate: true, review: first.review });
    const lesson = await memory.peekMemory(first.review.lessonId);
    expect(lesson).toMatchObject({ type: 'learning', content: input.lesson, sourceAgentId: 'cos-persistent-mind', sourceTaskId: context.turnId,
      typedLinks: [expect.objectContaining({ targetId: source.id, linkType: 'derived-from' })] });
    expect((await memory.peekMemory(source.id)).status).toBe('active');
    await review(source, 'archive');
    expect((await memory.peekMemory(source.id)).lastReview.outcomes.learn).toEqual(first.review);
    expect(await review(source, 'archive')).toMatchObject({ duplicate: true });
  });

  it('refuses foreign records, protected archival, stale content and changed replay arguments', async () => {
    const foreign = await memory.createMemory({ type: 'fact', content: 'Other agent', sourceAgentId: 'other-agent' });
    await expect(review(foreign, 'archive')).rejects.toMatchObject({ status: 404 });
    const source = await createPersistentMindMemory({ type: 'fact', content: 'Original prose' });
    await review(source, 'learn', { lesson: 'Original lesson' });
    await expect(review(source, 'learn', { lesson: 'Replacement lesson' })).rejects.toMatchObject({ code: 'MEMORY_REVIEW_CONFLICT' });
    await protectPersistentMindMemory({ memoryId: source.id, protection: 'important' });
    await expect(review(source, 'learn', { lesson: 'Original lesson' })).rejects.toMatchObject({ code: 'MEMORY_VERSION_CONFLICT' });
    const protectedSource = await memory.peekMemory(source.id);
    await expect(review(protectedSource, 'archive')).rejects.toMatchObject({ code: 'MEMORY_PROTECTED' });
    await updatePersistentMindMemory(source.id, { content: 'Corrected prose' });
    await expect(review(protectedSource, 'keep')).rejects.toMatchObject({ code: 'MEMORY_VERSION_CONFLICT' });
    expect((await memory.peekMemory(foreign.id)).status).toBe('active');
  });

  it('restores the file adapter source/index and removes a lesson when persistence fails', async () => {
    const source = await createPersistentMindMemory({ type: 'fact', content: 'Rollback source' });
    const before = await memory.getMemories();
    const original = await memory.peekMemory(source.id);
    const store = await import('./memoryStore.js');
    const originalSave = store.saveMemory;
    let failed = false;
    const save = vi.spyOn(store, 'saveMemory').mockImplementation(async record => {
      if (record.id === source.id && record.lastReview && !failed) {
        failed = true;
        throw new Error('Synthetic source write failure');
      }
      return originalSave(record);
    });
    await expect(review(source, 'learn', { lesson: 'Must roll back' })).rejects.toThrow('Synthetic source write failure');
    save.mockRestore();
    expect((await memory.getMemories()).total).toBe(before.total);
    expect(await memory.peekMemory(source.id)).toEqual(original);
  });

  it('requires explicit bounded verdicts and runtime provenance', async () => {
    const source = await createPersistentMindMemory({ type: 'fact', content: 'A synthetic fact' });
    expect(() => review(source, 'learn')).toThrow(/requires a nonempty lesson/);
    expect(() => review(source, 'defer', { lesson: 'No' })).toThrow(/other verdicts/);
    expect(() => review(source, 'keep', {}, {})).toThrow(/verified turn/);
    expect(() => review(source, 'maybe archive')).toThrow();
    await review(source, 'keep');
    expect((await memory.peekMemory(source.id)).content).toBe(source.content);
  });
});
