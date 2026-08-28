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
    createMemory: vi.fn(async (input) => ({ id: 'memory-automatic-1', ...input })),
    deleteMemory: vi.fn(async (id) => ({ success: true, id })),
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
  archivePersistentMindMemories,
  clearPersistentMindRollups,
  createPersistentMindMemoryFromCandidate,
  preparePersistentMindContext,
  promotePersistentMindMemory,
  readPersistentMindRollups,
} = await import('./persistentMindContext.js');

const ROLLUPS = join(CONTEXT_DIR, 'persistent-mind-rollups.json');

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
  mkdirSync(CONTEXT_DIR, { recursive: true });
  mock.history = [];
  mock.appendMindEvent.mockClear();
  mock.memoryApi.getMemories.mockClear();
  mock.memoryApi.peekMemory.mockClear();
  mock.memoryApi.createMemory.mockClear();
  mock.memoryApi.deleteMemory.mockClear();
});

afterAll(() => rmSync(CONTEXT_DIR, { recursive: true, force: true }));

describe('persistent mind rollups', () => {
  it('records source and model provenance and assembles it within the budget', async () => {
    mock.history = [event(1), event(2, 'mind.wake'), event(3, 'mind.turn.completed')];
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
      events: mock.history.slice(0, 2),
      promptVersion: 1,
    }));
    expect(rollup).toMatchObject({
      status: 'ready',
      summary: 'The older events established a useful decision.',
      source: { fromSequence: 1, toSequence: 2, fromEventId: 'event-1', toEventId: 'event-2' },
      provenance: { providerId: 'example-provider', model: 'example-model', promptVersion: 1 },
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
      previousProvenance: expect.objectContaining({ promptVersion: 1 }),
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
  it('archives active memories owned by the mind without hard-deleting them', async () => {
    mock.memoryApi.getMemories
      .mockResolvedValueOnce({ memories: [{ id: 'memory-owned' }, { id: 'memory-foreign' }] })
      .mockResolvedValueOnce({ memories: [] });
    mock.memoryApi.peekMemory
      .mockResolvedValueOnce({ id: 'memory-owned', status: 'active', sourceAgentId: 'cos-persistent-mind' })
      .mockResolvedValueOnce({ id: 'memory-foreign', status: 'active', sourceAgentId: 'other-agent' });

    await expect(archivePersistentMindMemories()).resolves.toEqual({ archived: 1 });
    expect(mock.memoryApi.deleteMemory).toHaveBeenCalledWith('memory-owned', false);
    expect(mock.memoryApi.deleteMemory).not.toHaveBeenCalledWith('memory-foreign', expect.anything());
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
      memoryApi: mock.memoryApi,
    });

    expect(created).toMatchObject({ success: true, duplicate: false, memory: { id: 'memory-automatic-1', status: 'active' } });
    expect(mock.memoryApi.createMemory).toHaveBeenCalledWith({
      content: 'Remember this automatically created fact.',
      summary: 'Automatic fact',
      type: 'fact',
      category: 'other',
      tags: ['durable'],
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
