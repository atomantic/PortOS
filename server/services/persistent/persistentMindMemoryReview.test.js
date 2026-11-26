import { afterAll, describe, expect, it, vi } from 'vitest';
import { mockPathsDataRoot } from '../../lib/mockPathsDataRoot.js';
const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-mind-review-' });
vi.mock('../../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../../lib/fileUtils.js')));
const memory = await import('../memory.js');
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
    expect((await memory.hybridSearchMemories('Preserve uncertainty', null)).memories.map(item => item.id)).toContain(lesson.id);
    await review(source, 'archive');
    expect((await memory.peekMemory(source.id)).lastReview.outcomes.learn).toEqual(first.review);
    expect(await review(source, 'archive')).toMatchObject({ duplicate: true });
    expect((await memory.hybridSearchMemories('synthetic observation', null)).memories.map(item => item.id)).not.toContain(source.id);
  });

  it('refuses foreign records, protected archival, stale content and changed replay arguments', async () => {
    const foreign = await memory.createMemory({ type: 'fact', content: 'Other agent', sourceAgentId: 'other-agent' });
    await expect(review(foreign, 'archive')).rejects.toMatchObject({ status: 404 });
    const source = await createPersistentMindMemory({ type: 'fact', content: 'Original prose' });
    await review(source, 'learn', { lesson: 'Original lesson' });
    await expect(review(source, 'learn', { lesson: 'Replacement lesson' })).rejects.toMatchObject({ code: 'MEMORY_REVIEW_CONFLICT' });
    await protectPersistentMindMemory({ memoryId: source.id, protection: 'important' });
    await expect(review(source, 'learn', { lesson: 'Original lesson' })).rejects.toMatchObject({ code: 'MEMORY_VERSION_CONFLICT' });
    const originalLesson = (await memory.peekMemory(source.id)).lastReview.outcomes.learn.lessonId;
    const protectedSource = await memory.peekMemory(source.id);
    await expect(review(protectedSource, 'archive')).rejects.toMatchObject({ code: 'MEMORY_PROTECTED' });
    await updatePersistentMindMemory(source.id, { content: 'Corrected prose' });
    await expect(review(protectedSource, 'keep')).rejects.toMatchObject({ code: 'MEMORY_VERSION_CONFLICT' });
    await review(await memory.peekMemory(source.id), 'keep');
    expect((await memory.peekMemory(originalLesson)).reviewOrigin).toMatchObject({ sourceId: source.id, sourceVersion: 1, mindId: 'cos-persistent-mind', ...context });
    expect((await memory.peekMemory(foreign.id)).status).toBe('active');
  });

  it('restores the file adapter source/index and removes a lesson when persistence fails', async () => {
    const source = await createPersistentMindMemory({ type: 'fact', content: 'Rollback source' });
    const before = await memory.getMemories();
    const original = await memory.peekMemory(source.id);
    const store = await import('../memoryStore.js');
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

// High-importance context pages must not hide an eligible reflection source.
it('selects by idle time, ownership, protection, age and review state without writing', async () => {
  const store = await import('../memoryStore.js');
  const { projectIndexMeta } = await import('../../lib/memoryQuery.js');
  const candidate = await createPersistentMindMemory({ type: 'observation', content: 'Idle for 200 days.', importance: 0.5 });
  const daysAgo = days => new Date(Date.now() - days * 86400000).toISOString();
  const aged = { ...candidate, createdAt: daysAgo(200), lastAccessed: daysAgo(200) };
  const older = { ...candidate, createdAt: daysAgo(210) };
  const recent = { ...older, id: 'recently-accessed', lastAccessed: daysAgo(10) };
  const nearThreshold = { ...older, id: 'near-threshold', lastAccessed: daysAgo(185) };
  const foreign = { ...older, id: 'foreign-source', sourceAgentId: 'other-agent' };
  const protectedSource = { ...older, id: 'protected-source', tags: ['mind:important'] };
  const young = { ...candidate, id: 'young-source', createdAt: daysAgo(20), importance: 0.1 };
  const records = [aged, recent, nearThreshold, foreign, protectedSource, young];
  const original = structuredClone(await store.loadIndex());
  const distractors = Array.from({ length: 120 }, (_, i) => ({ ...projectIndexMeta(candidate), id: `irrelevant-${i}`, importance: 0.9 }));
  for (const record of records) await store.saveMemory(record);
  const index = { ...original, memories: [...distractors, ...records.map(projectIndexMeta)] };
  await store.saveIndex(index);

  const mindId = 'cos-persistent-mind';
  expect(await memory.selectMindMemoryForReview(mindId)).toEqual(aged);
  expect(await Promise.all(records.map(({ id }) => memory.peekMemory(id)))).toEqual(records);
  expect(await store.loadIndex()).toEqual(index);
  await review(aged, 'keep');
  expect(await memory.selectMindMemoryForReview(mindId)).toBeNull();
  await store.saveMemory({ ...await memory.peekMemory(aged.id), lastAccessed: null });
  await memory.updateMemory(aged.id, { content: 'Changed exact source.' });
  expect(await memory.selectMindMemoryForReview(mindId)).toMatchObject({ id: aged.id, version: 2 });
  await store.saveIndex(original);
});

describe('continuation note on the real memory store and ledger', () => {
  it('keeps attribution across replacement, compaction reads and a clear', async () => {
    const { applyPersistentMindContinuationNote, preparePersistentMindContext, readPersistentMindMemories } = await import('./persistentMindContext.js');
    const apply = (turnId, note, providerId) => applyPersistentMindContinuationNote({ turnId, note, providerId, model: 'model-example' });

    await apply('note-turn-1', 'First note.', 'provider-a');
    const replaced = await apply('note-turn-2', 'Second note.', 'provider-b');
    expect(replaced).toMatchObject({ action: 'updated', version: 2 });

    const wake = await preparePersistentMindContext({ providerId: 'provider-c' });
    const current = wake.continuationNote;
    expect(wake.text).toContain('Second note.');
    expect(current).toMatchObject({ state: 'included', content: 'Second note.', version: 2, provenance: { turnId: 'note-turn-2', providerId: 'provider-b', model: 'model-example' } });
    expect((await readPersistentMindMemories()).map((item) => item.id)).not.toContain(current.memoryId);

    expect(await apply('note-turn-3', '', 'provider-b')).toMatchObject({ action: 'cleared' });
    expect((await preparePersistentMindContext({})).continuationNote).toEqual({ state: 'none' });
    expect(await memory.peekMemory(current.memoryId)).toMatchObject({ status: 'archived', content: 'Second note.' });
  });
});
