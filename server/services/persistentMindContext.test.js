import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mock = vi.hoisted(() => ({
  history: [],
  appendMindEvent: vi.fn(async (event) => ({ appended: true, event })),
  memoryApi: {
    getMemories: vi.fn(async () => ({ memories: [] })),
    peekMemory: vi.fn(),
    selectMindMemoryForReview: vi.fn(),
    createMemory: vi.fn(async (input) => ({ id: 'memory-automatic-1', ...input })),
    archiveMemory: vi.fn(async (id) => ({ success: true, id })),
    updateMemory: vi.fn(),
  },
}));

const { CONTEXT_DIR } = await vi.hoisted(async () => {
  const { mkdtempSync: mk } = await import('fs');
  const { tmpdir: tmp } = await import('os');
  const { join: pathJoin } = await import('path');
  return { CONTEXT_DIR: mk(pathJoin(tmp(), 'portos-mind-context-')) };
});

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, cos: CONTEXT_DIR } };
});

vi.mock('./agentRunEventLog.js', () => ({
  appendMindEvent: (...args) => mock.appendMindEvent(...args),
  readPersistentMindHistory: vi.fn(async () => mock.history),
}));
vi.mock('./memoryBackend.js', () => mock.memoryApi);

const {
  appendPersistentMindAnnotation,
  applyPersistentMindContinuationNote,
  archivePersistentMindMemories,
  clearPersistentMindRollups,
  createPersistentMindMemoryFromCandidate,
  createPersistentMindMemory,
  choosePersistentMindName,
  readPersistentMindMemories,
  updatePersistentMindMemory,
  protectPersistentMindMemory,
  preparePersistentMindContext,
  promotePersistentMindMemory,
  readPersistentMindRollups,
} = await import('./persistentMindContext.js');
const { buildPersistentMindCallDenial, PERSISTENT_MIND_ROLLUP_PROMPT_VERSION } = await import('../lib/persistentMindTrajectory.js');

const ROLLUPS = join(CONTEXT_DIR, 'persistent-mind-rollups.json');
const JOURNAL = join(CONTEXT_DIR, 'persistent-mind-journal.json');

const event = (sequence, kind = 'mind.message.accepted') => ({
  schemaVersion: 1,
  eventId: `event-${sequence}`,
  kind,
  runId: null,
  agentId: null,
  taskId: null,
  mindId: 'cos-persistent-mind',
  turnId: kind === 'mind.message.accepted' ? null : 'turn-1',
  sequence,
  at: `2026-08-25T12:00:0${sequence}.000Z`,
  data: { displayText: `Visible event ${sequence}`, previousSequence: sequence > 1 ? sequence - 1 : null },
});

beforeEach(() => {
  if (existsSync(ROLLUPS)) rmSync(ROLLUPS);
  if (existsSync(JOURNAL)) rmSync(JOURNAL);
  mkdirSync(CONTEXT_DIR, { recursive: true });
  mock.history = [];
  mock.appendMindEvent.mockClear();
  mock.memoryApi.getMemories.mockReset().mockResolvedValue({ memories: [] });
  mock.memoryApi.peekMemory.mockReset();
  mock.memoryApi.updateMemory.mockReset();
  mock.memoryApi.createMemory.mockClear();
  mock.memoryApi.archiveMemory.mockReset().mockImplementation(async (id) => ({ success: true, id }));
});

afterAll(() => rmSync(CONTEXT_DIR, { recursive: true, force: true }));

describe('chosen identity continuity', () => {
  it('selects and later renames one protected record across reload, cleanup and provider changes', async () => {
    const records = new Map();
    mock.memoryApi.getMemories.mockImplementation(async ({ offset = 0 }) => ({ memories: [...records.values()].filter((m) => m.status === 'active').slice(offset, offset + 100) }));
    mock.memoryApi.peekMemory.mockImplementation(async (id) => records.get(id));
    mock.memoryApi.createMemory.mockImplementationOnce(async (input) => {
      const memory = { id: 'chosen-identity', ...input };
      records.set(memory.id, memory);
      return memory;
    });
    mock.memoryApi.updateMemory.mockImplementation(async (id, updates) => {
      const memory = { ...records.get(id), ...updates };
      records.set(id, memory);
      return memory;
    });
    expect(await choosePersistentMindName({ name: 'Example Star' })).toMatchObject({ name: 'Example Star', previousName: null, mindId: 'cos-persistent-mind' });
    records.set('legacy', { id: 'legacy', content: 'My chosen name is Earlier.', tags: ['mind:core-identity'], sourceAgentId: 'cos-persistent-mind', status: 'active' });
    vi.resetModules();
    const reloaded = await import('./persistentMindContext.js');
    expect(await reloaded.choosePersistentMindName({ name: 'Étoile' })).toMatchObject({ name: 'Étoile', previousName: 'Example Star', memoryId: 'chosen-identity' });
    expect(records.size).toBe(2);
    expect(await reloaded.readPersistentMindName()).toBe('Étoile');
    expect(await reloaded.archivePersistentMindMemories()).toEqual({ archived: 0, preserved: 2 });
    await reloaded.clearPersistentMindRollups();
    const context = await reloaded.preparePersistentMindContext({ memories: await reloaded.readPersistentMindMemories(), providerId: 'other-provider', model: 'other-model' });
    expect(context.text).toContain('Current chosen display name: "Étoile"');
    expect(context.text).toContain('mindId=cos-persistent-mind');
    expect(mock.appendMindEvent).not.toHaveBeenCalled();
  });
});

describe('persistent mind rollups', () => {
  it('records source and model provenance and assembles it within the budget', async () => {
    mock.history = [event(1), event(2, 'mind.wake'), event(3, 'mind.reply')];
    const summarize = vi.fn(async () => 'The older events established a useful decision.');

    const context = await preparePersistentMindContext({
      identity: 'Stable example identity.',
      recentEventLimit: 1,
      maxChars: 1_500,
      providerId: 'example-provider',
      model: 'example-model',
      summarize,
    });
    const [rollup] = await readPersistentMindRollups();

    expect(summarize).toHaveBeenCalledWith(expect.objectContaining({
      mindId: 'cos-persistent-mind',
      source: expect.objectContaining({ fromSequence: 1, toSequence: 2 }),
      events: mock.history.slice(0, 1),
      promptVersion: PERSISTENT_MIND_ROLLUP_PROMPT_VERSION,
    }));
    expect(rollup).toMatchObject({
      status: 'ready',
      summary: 'The older events established a useful decision.',
      source: { fromSequence: 1, toSequence: 2, fromEventId: 'event-1', toEventId: 'event-2' },
      provenance: { providerId: 'example-provider', model: 'example-model', promptVersion: PERSISTENT_MIND_ROLLUP_PROMPT_VERSION },
    });
    expect(context.summaryState).toBe('ready');
    expect(context.chars).toBeLessThanOrEqual(1_500);
    expect(context.text).toContain('The older events established a useful decision.');
    expect(mock.appendMindEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'mind.summary',
      data: expect.objectContaining({ status: 'ready', fromSequence: 1, toSequence: 2 }),
    }));
  });

  it('keeps a failed summary explicit without erasing raw history or retrying silently', async () => {
    mock.history = [event(1), event(2), event(3)];
    const summarize = vi.fn(async () => { throw new Error('summary provider unavailable'); });

    const first = await preparePersistentMindContext({ recentEventLimit: 1, summarize });
    const second = await preparePersistentMindContext({ recentEventLimit: 1, summarize });
    const [rollup] = await readPersistentMindRollups();

    expect(first.summaryState).toBe('failed');
    expect(second.summaryState).toBe('failed');
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(mock.history).toHaveLength(3);
    expect(rollup).toMatchObject({ status: 'failed', summary: null, error: 'summary provider unavailable' });
  });

  it.each(['summary', 'journal'])('propagates a runtime hold during %s before further context effects', async (stage) => {
    mock.history = [event(1), event(2), event(3)];
    const held = Object.assign(buildPersistentMindCallDenial({ reason: 'Maintainer runtime budget exhausted',
      status: 'waiting', code: 'runtime-budget-exhausted' }), { code: 'RUN_RUNTIME_BUDGET_EXHAUSTED' });
    const summarize = vi.fn(async () => { if (stage === 'summary') throw held; return 'summary'; });
    const extractJournal = vi.fn(async () => { if (stage === 'journal') throw held; return '{"operations":[]}'; });
    await expect(preparePersistentMindContext({ recentEventLimit: 1, summarize, extractJournal })).rejects.toBe(held);
    if (stage === 'journal') expect(summarize).not.toHaveBeenCalled();
    expect(await readPersistentMindRollups()).toEqual([]);
    expect(mock.appendMindEvent).not.toHaveBeenCalled();
  });

  it('leaves the range unattempted when the per-call boundary refuses the summary', async () => {
    mock.history = [event(1), event(2), event(3)];
    const summarize = vi.fn(async () => {
      throw buildPersistentMindCallDenial({ reason: 'CoS actions budget exhausted', status: 'waiting' });
    });

    const first = await preparePersistentMindContext({ recentEventLimit: 1, summarize });
    const second = await preparePersistentMindContext({ recentEventLimit: 1, summarize });

    // No rollup was sealed, so the next turn still retries the same range —
    // a refused call never reached a provider and never summarized anything.
    expect(await readPersistentMindRollups()).toEqual([]);
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(first.summaryState).toBe('unavailable');
    expect(second.summaryState).toBe('unavailable');
    expect(mock.appendMindEvent).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'mind.summary' }));
    expect(mock.history).toHaveLength(3);
  });

  it('extracts the journal before sealing the range, feeds it to the summarizer, and renders it into the next context', async () => {
    // The whole point of the journal: what the mind still owes the user has to
    // reach the summarizer that compacts the range AND the context assembled
    // for the next wake. Extracting after the seal would give the summary
    // nothing to compact from.
    mock.history = [event(1), event(2), event(3)];
    const order = [];
    const extractJournal = vi.fn(async () => {
      order.push('extract');
      return JSON.stringify({ operations: [{ op: 'append', kind: 'commitment', statement: 'I owe a migration plan.', sourceSequences: [1] }] });
    });
    const summarize = vi.fn(async () => { order.push('summarize'); return 'Sealed from the journal.'; });

    const context = await preparePersistentMindContext({ recentEventLimit: 1, summarize, extractJournal });

    expect(order).toEqual(['extract', 'summarize']);
    expect(summarize).toHaveBeenCalledWith(expect.objectContaining({
      journal: [expect.objectContaining({ statement: 'I owe a migration plan.', status: 'active' })],
    }));
    expect(context.text).toContain('# Decision journal');
    expect(context.text).toContain('I owe a migration plan.');
    expect(context.journalActiveCount).toBe(1);
  });

  it('seals the range anyway when journal extraction fails', async () => {
    mock.history = [event(1), event(2), event(3)];
    const extractJournal = vi.fn(async () => 'not json');
    const summarize = vi.fn(async () => 'Sealed without a journal.');

    const context = await preparePersistentMindContext({ recentEventLimit: 1, summarize, extractJournal });

    expect(summarize).toHaveBeenCalledWith(expect.objectContaining({ journal: [] }));
    expect(context.summaryState).toBe('ready');
    expect((await readPersistentMindRollups())[0]).toMatchObject({ status: 'ready' });
  });

  it('rejects an empty or whitespace-only summary as a failed attempt', async () => {
    mock.history = [event(1), event(2), event(3)];
    const summarize = vi.fn(async () => '   ');

    const context = await preparePersistentMindContext({ recentEventLimit: 1, summarize });
    const [rollup] = await readPersistentMindRollups();

    expect(context.summaryState).toBe('failed');
    expect(rollup).toMatchObject({
      status: 'failed',
      summary: null,
      error: 'Persistent mind summarizer returned no summary text',
    });
  });

  it('gives a forced retry its own trajectory event so a successful retry is not deduped against the earlier failure', async () => {
    mock.history = [event(1), event(2), event(3)];
    const summarize = vi.fn(async () => { throw new Error('summary provider unavailable'); });

    await preparePersistentMindContext({ recentEventLimit: 1, summarize });
    mock.appendMindEvent.mockClear();
    summarize.mockImplementation(async () => 'Recovered after the provider came back.');

    await preparePersistentMindContext({ recentEventLimit: 1, summarize, forceSummary: true });
    const [rollup] = await readPersistentMindRollups();

    expect(rollup).toMatchObject({ status: 'ready', summary: 'Recovered after the provider came back.' });
    expect(mock.appendMindEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'mind.summary',
      data: expect.objectContaining({ status: 'ready' }),
    }));
    const retryEventId = mock.appendMindEvent.mock.calls.find(
      ([call]) => call.kind === 'mind.summary'
    )[0].eventId;
    expect(retryEventId).toBeTruthy();
    // The retry's event id must differ from an id derived from rollup.id alone
    // (which is unchanged across attempts) — otherwise the shared ledger's
    // dedupe would silently drop this event and the replayed trajectory would
    // stay stuck on the earlier failed attempt forever.
    const staleEventId = `mind-summary-${(await import('../lib/fileUtils.js')).sha256Text(rollup.id).slice(0, 32)}`;
    expect(retryEventId).not.toBe(staleEventId);
  });

  it('builds cumulative rollups so a bounded cache retains the full summarized life', async () => {
    mock.history = [event(1), event(2), event(3)];
    const summarize = vi.fn()
      .mockResolvedValueOnce('First cumulative summary.')
      .mockResolvedValueOnce('Updated cumulative summary.');

    await preparePersistentMindContext({ recentEventLimit: 1, summarize });
    mock.history = [...mock.history, event(4)];
    const context = await preparePersistentMindContext({ recentEventLimit: 1, summarize });
    const rollups = await readPersistentMindRollups();

    expect(summarize).toHaveBeenLastCalledWith(expect.objectContaining({
      source: expect.objectContaining({ fromSequence: 1, toSequence: 3 }),
      events: [mock.history[2]],
      previousSummary: 'First cumulative summary.',
      previousProvenance: expect.objectContaining({ promptVersion: PERSISTENT_MIND_ROLLUP_PROMPT_VERSION }),
    }));
    expect(rollups.at(-1)).toMatchObject({
      status: 'ready',
      summary: 'Updated cumulative summary.',
      source: { fromSequence: 1, toSequence: 3, fromEventId: 'event-1', toEventId: 'event-3' },
    });
    expect(context.summaryState).toBe('ready');
    expect(context.text).toContain('Updated cumulative summary.');
    expect(context.text).not.toContain('First cumulative summary.');
  });

  it('reports a retained-history gap instead of claiming complete rollup coverage', async () => {
    mock.history = [event(2), event(3), event(4)];

    const context = await preparePersistentMindContext({ recentEventLimit: 1 });

    expect(await readPersistentMindRollups()).toEqual([]);
    expect(context).toMatchObject({
      summaryState: 'gap',
      coverageGap: {
        expectedAfterSequence: null,
        retainedFromSequence: 2,
        recordedPredecessorSequence: 1,
      },
    });
    expect(context.text).toContain('summary-cache=gap');
  });

  it('detects a missing event inside the retained summary range', async () => {
    mock.history = [event(1), event(2), event(4), event(5)];
    const summarize = vi.fn(async () => 'This must not bridge the missing sequence.');

    const context = await preparePersistentMindContext({ recentEventLimit: 1, summarize });

    expect(summarize).not.toHaveBeenCalled();
    expect(context).toMatchObject({
      summaryState: 'gap',
      coverageGap: {
        expectedAfterSequence: 2,
        retainedFromSequence: 4,
        recordedPredecessorSequence: 3,
      },
    });
  });

  it('fails closed on a corrupt cache instead of replacing it with empty state', async () => {
    writeFileSync(ROLLUPS, '{broken');

    await expect(readPersistentMindRollups()).rejects.toThrow('rollup cache is unreadable');
    await expect(preparePersistentMindContext()).rejects.toThrow('rollup cache is unreadable');
    expect(readFileSync(ROLLUPS, 'utf8')).toBe('{broken');
  });

  it('clears only the selected mind derived rollups', async () => {
    mock.history = [event(1), event(2), event(3)];
    await preparePersistentMindContext({ recentEventLimit: 1, summarize: async () => 'Default mind summary.' });
    const foreign = (await readPersistentMindRollups())[0];
    writeFileSync(ROLLUPS, JSON.stringify({
      schemaVersion: 1,
      rollups: [foreign, { ...foreign, id: 'future-mind:1-2:v1', mindId: 'future-mind' }],
    }));

    await expect(clearPersistentMindRollups()).resolves.toEqual({ cleared: 1 });
    expect(await readPersistentMindRollups()).toEqual([]);
    expect(await readPersistentMindRollups('future-mind')).toHaveLength(1);
  });
});

describe('persistent mind memory cleanup', () => {
  it('preserves protected pages, archives later ordinary memories, and keeps identity in rebuilt context', async () => {
    const records = new Map(Array.from({ length: 102 }, (_, index) => {
      const memory = { id: `memory-${index}`, sourceAgentId: 'cos-persistent-mind', status: 'active',
        content: index === 0 ? 'My chosen name is Aster.' : `Retained knowledge ${index}`,
        tags: [index === 0 ? 'mind:core-identity' : 'mind:important'], importance: index === 0 ? 0 : 0.1 };
      return [memory.id, memory];
    }));
    records.set('ordinary', { id: 'ordinary', sourceAgentId: 'cos-persistent-mind', status: 'active', content: 'Stale detail.', tags: [], importance: 1 });
    mock.memoryApi.getMemories.mockImplementation(async ({ offset = 0, limit = 100, tags, sortBy }) => ({
      memories: [...records.values()].filter((memory) => memory.status === 'active' && (!tags || tags.some((tag) => memory.tags.includes(tag)))).sort((a, b) => sortBy === 'importance' ? b.importance - a.importance : 0).slice(offset, offset + limit),
    }));
    mock.memoryApi.peekMemory.mockImplementation(async (id) => structuredClone(records.get(id)));
    mock.memoryApi.archiveMemory.mockImplementation(async (id) => { records.get(id).status = 'archived'; });

    await expect(archivePersistentMindMemories()).resolves.toEqual({ archived: 1, preserved: 102 });
    expect(mock.memoryApi.archiveMemory).toHaveBeenCalledTimes(1);
    expect(mock.memoryApi.archiveMemory).toHaveBeenCalledWith('ordinary');
    await expect(archivePersistentMindMemories()).resolves.toEqual({ archived: 0, preserved: 102 });
    const memories = await readPersistentMindMemories();
    expect(memories[0]).toMatchObject({ id: 'memory-0', protection: 'core-identity' });
    const context = await preparePersistentMindContext({ memories });
    expect(context.text).toContain('My chosen name is Aster.');
    expect(context.text).toContain('protected=core-identity');
    expect(context.text).not.toContain('Stale detail.');
  });

  it('persists explicit protection, preserves it through legacy edits, and limits mind changes to owned protection', async () => {
    const memory = { id: 'identity', status: 'active', sourceAgentId: 'cos-persistent-mind', content: 'My chosen name is Aster.', tags: [] };
    mock.memoryApi.peekMemory.mockImplementation(async (id) => id === memory.id ? structuredClone(memory) : { ...memory, sourceAgentId: 'other-agent' });
    mock.memoryApi.updateMemory.mockImplementation(async (_id, updates) => Object.assign(memory, updates));
    await expect(protectPersistentMindMemory({ memoryId: 'identity', protection: 'core-identity' })).resolves.toMatchObject({ success: true });
    await updatePersistentMindMemory('identity', { content: 'I use the name Aster.', tags: ['name'] });
    expect(memory.tags).toEqual(['name', 'mind:core-identity']);
    await expect(protectPersistentMindMemory({ memoryId: 'identity', protection: 'important' })).resolves.toMatchObject({ protection: 'core-identity' });
    expect(() => protectPersistentMindMemory({ memoryId: 'identity', protection: 'standard' })).toThrow();
    await expect(protectPersistentMindMemory({ memoryId: 'foreign', protection: 'important' })).resolves.toMatchObject({ success: false });
    await updatePersistentMindMemory('identity', { protection: 'standard' });
    expect(memory.tags).toEqual(['name']);
    await createPersistentMindMemory({ content: 'An enduring commitment.', protection: 'important', tags: ['commitment'] });
    expect(mock.memoryApi.createMemory).toHaveBeenLastCalledWith(expect.objectContaining({ tags: ['commitment', 'mind:important'] }));
  });

  it('archives active memories owned by the mind without hard-deleting them', async () => {
    mock.memoryApi.getMemories
      .mockResolvedValueOnce({ memories: [{ id: 'memory-owned' }, { id: 'memory-foreign' }] })
      .mockResolvedValueOnce({ memories: [] });
    mock.memoryApi.peekMemory
      .mockResolvedValueOnce({ id: 'memory-owned', status: 'active', sourceAgentId: 'cos-persistent-mind' })
      .mockResolvedValueOnce({ id: 'memory-foreign', status: 'active', sourceAgentId: 'other-agent' });

    await expect(archivePersistentMindMemories()).resolves.toEqual({ archived: 1, preserved: 0 });
    expect(mock.memoryApi.archiveMemory).toHaveBeenCalledWith('memory-owned');
    expect(mock.memoryApi.archiveMemory).not.toHaveBeenCalledWith('memory-foreign');
  });
});

describe('trajectory annotations and Brain promotion', () => {
  it('automatically creates a mind-owned memory without approval', async () => {
    const created = await createPersistentMindMemoryFromCandidate({
      candidateId: 'turn-automatic:0',
      turnId: 'turn-automatic',
      content: 'Remember this automatically created fact.',
      summary: 'Automatic fact',
      type: 'fact',
      category: 'other',
      tags: ['durable', 'durable'],
      protection: 'core-identity',
      memoryApi: mock.memoryApi,
    });

    expect(created).toMatchObject({ success: true, duplicate: false, memory: { id: 'memory-automatic-1', status: 'active' } });
    expect(mock.memoryApi.createMemory).toHaveBeenCalledWith({
      content: 'Remember this automatically created fact.',
      summary: 'Automatic fact',
      type: 'fact',
      category: 'other',
      tags: ['durable', 'mind:core-identity'],
      sourceTaskId: 'turn-automatic',
      sourceAgentId: 'cos-persistent-mind',
      status: 'active',
    });
  });

  it('keeps comments attributable to their turn and target event', async () => {
    await expect(appendPersistentMindAnnotation({
      id: 'annotation-1',
      turnId: 'turn-1',
      targetEventId: 'event-2',
      text: 'Use the bounded variant.',
      at: '2026-08-25T12:30:00.000Z',
    })).resolves.toMatchObject({ appended: true });

    expect(mock.appendMindEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'mind.annotation.accepted',
      turnId: 'turn-1',
      data: expect.objectContaining({
        annotationId: 'annotation-1',
        targetEventId: 'event-2',
        displayText: 'Use the bounded variant.',
      }),
    }));
  });

  it('requires explicit approval before creating a Brain memory', async () => {
    const memoryApi = { createMemory: vi.fn(async (input) => ({ id: 'memory-1', ...input })) };

    await expect(promotePersistentMindMemory({
      id: 'promotion-refused',
      approved: false,
      content: 'Remember this.',
      memoryApi,
    })).resolves.toEqual({ success: false, error: 'Explicit user approval is required' });
    expect(memoryApi.createMemory).not.toHaveBeenCalled();
    expect(mock.appendMindEvent).not.toHaveBeenCalled();

    const promoted = await promotePersistentMindMemory({
      id: 'promotion-1',
      approved: true,
      turnId: 'turn-1',
      sourceEventId: 'event-2',
      content: 'Remember this user-approved fact.',
      summary: 'Approved fact',
      tags: ['approved', 'approved'],
      memoryApi,
    });

    expect(promoted).toMatchObject({ success: true, memory: { id: 'memory-1', status: 'active' } });
    expect(memoryApi.createMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Remember this user-approved fact.',
      summary: 'Approved fact',
      tags: ['approved'],
      sourceTaskId: 'turn-1',
      sourceAgentId: 'cos-persistent-mind',
      status: 'active',
    }));
    expect(mock.appendMindEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'mind.memory.promoted',
      turnId: 'turn-1',
      data: expect.objectContaining({
        promotionId: 'promotion-1', memoryId: 'memory-1', sourceEventId: 'event-2', approved: true,
      }),
    }));

    mock.history = [{
      kind: 'mind.memory.promoted',
      data: { promotionId: 'promotion-1', memoryId: 'memory-1' },
    }];
    await expect(promotePersistentMindMemory({
      id: 'promotion-1',
      approved: true,
      content: 'Remember this user-approved fact.',
      memoryApi,
    })).resolves.toMatchObject({ success: true, duplicate: true, memory: { id: 'memory-1' } });
    expect(memoryApi.createMemory).toHaveBeenCalledTimes(1);
  });
});

it('distinguishes disabled, empty, unavailable and stale reflection reads without writes', async () => {
  const { readPersistentMindReflection, revalidatePersistentMindReflection } = await import('./persistentMindContext.js');
  const source = { id: 'source', version: 1, status: 'active', sourceAgentId: 'cos-persistent-mind', tags: [], content: 'Exact source' };
  mock.memoryApi.selectMindMemoryForReview.mockResolvedValue(source);
  expect(await readPersistentMindReflection()).toMatchObject({ state: 'disabled' });
  expect(mock.memoryApi.selectMindMemoryForReview).not.toHaveBeenCalled();
  expect(await readPersistentMindReflection({ enabled: true })).toMatchObject({ state: 'pending', source });
  mock.memoryApi.peekMemory.mockResolvedValue({ ...source, version: undefined });
  expect(await revalidatePersistentMindReflection({ source }, true)).toBe('pending');
  mock.memoryApi.peekMemory.mockResolvedValue({ ...source, version: 2 });
  expect(await revalidatePersistentMindReflection({ source }, true)).toBe('changed');
  mock.history = [{ data: { memoryReview: { memoryId: source.id } } }];
  mock.memoryApi.peekMemory.mockResolvedValue({ ...source, lastReview: { expectedVersion: 1, latestVerdict: 'keep' } });
  expect(await readPersistentMindReflection({ enabled: true })).toMatchObject({ inspected: { id: source.id, lastReview: { latestVerdict: 'keep' } } });
  mock.memoryApi.selectMindMemoryForReview.mockResolvedValue(null);
  expect(await readPersistentMindReflection({ enabled: true })).toMatchObject({ state: 'empty' });
  mock.memoryApi.selectMindMemoryForReview.mockRejectedValue(new Error('Unavailable'));
  expect(await readPersistentMindReflection({ enabled: true })).toMatchObject({ state: 'unavailable' });
  expect(mock.memoryApi.createMemory).not.toHaveBeenCalled();
});

describe('continuation note', () => {
  const NOTE = 'Open thread: the draft is waiting on review. Next: read ```the reply``` first.';
  let records;

  const installStore = () => {
    records = new Map();
    let created = 0;
    mock.memoryApi.getMemories.mockImplementation(async ({ tags, status, offset = 0, limit = 100 }) => ({
      memories: [...records.values()]
        .filter((memory) => memory.status === status && (!tags || tags.some((tag) => memory.tags.includes(tag))))
        .slice(offset, offset + limit),
    }));
    mock.memoryApi.peekMemory.mockImplementation(async (id) => structuredClone(records.get(id)));
    mock.memoryApi.createMemory.mockImplementation(async (input) => {
      const memory = { id: `note-${++created}`, version: 1, updatedAt: '2026-01-01T00:00:00.000Z', ...input };
      records.set(memory.id, memory);
      return structuredClone(memory);
    });
    mock.memoryApi.updateMemory.mockImplementation(async (id, { expectedVersion, changedBy: _by, changeReason: _reason, ...updates }) => {
      const memory = records.get(id);
      if (expectedVersion !== undefined && expectedVersion !== memory.version) {
        throw Object.assign(new Error('conflict'), { code: 'MEMORY_VERSION_CONFLICT' });
      }
      const next = { ...memory, ...updates, version: memory.version + Number(updates.content !== undefined) };
      records.set(id, next);
      return structuredClone(next);
    });
    mock.appendMindEvent.mockImplementation(async (event) => {
      mock.history.push({ ...event, at: '2026-01-02T00:00:00.000Z' });
      return { appended: true, event };
    });
  };

  const write = (turnId, note, overrides = {}) => applyPersistentMindContinuationNote({
    turnId, note, providerId: 'provider-a', model: 'model-a', ...overrides,
  });

  beforeEach(() => {
    mock.history = [];
    installStore();
  });

  it('reaches later wakes unchanged, once, across provider swaps and past the ordinary memory page', async () => {
    for (let index = 0; index < 150; index += 1) {
      records.set(`ordinary-${index}`, { id: `ordinary-${index}`, status: 'active', sourceAgentId: 'cos-persistent-mind', content: `Ordinary ${index}`, tags: [], importance: 1 });
    }
    await write('turn-1', NOTE);
    const memories = await readPersistentMindMemories();
    expect(memories.some((memory) => memory.content === NOTE)).toBe(false);

    const context = await preparePersistentMindContext({ memories, providerId: 'provider-b', model: 'model-b', maxChars: 100_000 });
    expect(context.text.split(NOTE)).toHaveLength(2);
    expect(context.text).toContain('Written by this mind at 2026-01-02T00:00:00.000Z, turn turn-1, on provider-a/model-a.');
    expect(context.continuationNote).toMatchObject({ state: 'included', content: NOTE, version: 1 });
    expect(mock.history).toHaveLength(1);
    expect(JSON.stringify(mock.history)).not.toContain('the draft');
  });

  it('replaces through a version, clears to history, and starts a fresh record afterward', async () => {
    await write('turn-1', NOTE);
    expect(await write('turn-2', 'Second note')).toMatchObject({ action: 'updated', version: 2 });
    expect(records.get('note-1').content).toBe('Second note');

    expect(await write('turn-3', '')).toMatchObject({ action: 'cleared', memoryId: 'note-1' });
    expect(records.get('note-1')).toMatchObject({ status: 'archived', content: 'Second note' });
    expect((await preparePersistentMindContext({})).continuationNote).toEqual({ state: 'none' });
    expect(mock.history.at(-1)).toMatchObject({ kind: 'mind.continuation.cleared', turnId: 'turn-3' });

    expect(await write('turn-4', 'Third note')).toMatchObject({ action: 'created', memoryId: 'note-2' });
  });

  it('applies one turn once and refuses a replacement of a note it did not read', async () => {
    await write('turn-1', NOTE);
    expect(await write('turn-1', 'Different retry text')).toMatchObject({ action: 'replayed' });
    expect(records.get('note-1')).toMatchObject({ content: NOTE, version: 1 });

    expect(await write('turn-2', NOTE)).toMatchObject({ action: 'unchanged' });
    expect(records.get('note-1').version).toBe(1);

    expect(await write('turn-3', 'Stale', { expected: { memoryId: 'note-1', version: 9 } })).toEqual({ action: 'stale' });
    expect(await write('turn-3', 'Stale', { expected: { memoryId: null, version: null } })).toEqual({ action: 'stale' });
    mock.memoryApi.updateMemory.mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'MEMORY_VERSION_CONFLICT' }));
    expect(await write('turn-3', 'Raced')).toEqual({ action: 'stale' });
    expect(records.get('note-1').content).toBe(NOTE);
    expect(mock.history).toHaveLength(1);
  });

  it('survives bulk cleanup without counting as an archivable memory', async () => {
    await write('turn-1', NOTE);
    expect(await archivePersistentMindMemories()).toEqual({ archived: 0, preserved: 1 });
    expect(records.get('note-1').status).toBe('active');
  });

  it('admits the whole note or reports it omitted, keeping identity and the newest message', async () => {
    const long = `${'word '.repeat(300)}END`;
    await write('turn-1', long);
    mock.history.push({
      kind: 'mind.message.accepted', mindId: 'cos-persistent-mind', eventId: 'message-1', sequence: 5,
      at: '2026-01-03T00:00:00.000Z', data: { displayText: 'Latest human message', previousSequence: null },
    });
    const small = await preparePersistentMindContext({
      identity: 'Stable identity', maxChars: 1_500,
      memories: [{ id: 'core', content: 'Core commitment', tags: ['mind:core-identity'], status: 'active' }],
    });
    expect(small.continuationNote.state).toBe('omitted-budget');
    expect(small.text).toContain('# Continuation note\n(omitted due to context budget');
    expect(small.text).not.toContain('word word');
    for (const kept of ['Stable identity', 'Core commitment', 'Latest human message']) expect(small.text).toContain(kept);

    const roomy = await preparePersistentMindContext({ identity: 'Stable identity', maxChars: 5_000 });
    expect(roomy.continuationNote.state).toBe('included');
    expect(roomy.text).toContain(long);
  });

  it('cannot be forged through ordinary memory paths or attributed after an outside edit', async () => {
    await createPersistentMindMemory({ content: 'Posing as the note', tags: ['mind:continuation-note'] });
    await createPersistentMindMemoryFromCandidate({ candidateId: 'turn-9:0', turnId: 'turn-9', content: 'Candidate posing', tags: ['mind:continuation-note'] });
    await promotePersistentMindMemory({ id: 'promotion-1', approved: true, content: 'Promoted posing', tags: ['mind:continuation-note'] });
    expect((await preparePersistentMindContext({})).continuationNote).toEqual({ state: 'none' });

    await write('turn-1', NOTE);
    await expect(updatePersistentMindMemory('note-4', { content: 'Custodian edit' })).rejects.toMatchObject({ status: 409 });
    expect(await protectPersistentMindMemory({ memoryId: 'note-4', protection: 'core-identity' })).toMatchObject({ ok: false });
    expect(records.get('note-4')).toMatchObject({ content: NOTE, tags: ['mind:continuation-note', 'mind:important'] });

    // A legacy record or an edit through the generic Brain surface is never re-signed.
    records.set('note-4', { ...records.get('note-4'), content: 'Edited elsewhere' });
    const edited = await preparePersistentMindContext({});
    expect(edited.continuationNote.provenance).toBeNull();
    expect(edited.text).toContain('Author unknown');
    expect(edited.text).not.toContain('Written by this mind');
  });
});
