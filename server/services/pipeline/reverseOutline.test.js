import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory outline store mirroring atomicWrite(object) + readJSONFile(object|fallback).
const fileStore = new Map();

vi.mock('../../lib/fileUtils.js', () => ({
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, JSON.parse(JSON.stringify(data))); }),
  readJSONFile: vi.fn(async (path, fallback = null) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

// runStagedLLM returns the next queued canned outline.
const llmQueue = [];
const llmCalls = [];
vi.mock('../../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn(async (stage, vars) => {
    llmCalls.push({ stage, vars });
    const content = llmQueue.shift();
    return { content, model: 'mock-model', providerId: 'mock-provider', runId: 'run-1' };
  }),
  // Large window so the content cap stays at its CONTENT_MAX floor in tests.
  resolveStageContext: vi.fn(async () => ({ provider: { id: 'mock-provider' }, model: 'mock-model', contextWindow: 1_000_000 })),
}));

vi.mock('../../lib/contextBudget.js', () => ({
  usableInputTokens: vi.fn(() => 100_000),
  estimateTokens: vi.fn(() => 100),
  CHARS_PER_TOKEN: 4,
}));

// Series store (recordDir for the sibling path) + getSeries.
const seriesFixture = new Map();
vi.mock('./series.js', () => ({
  seriesStore: () => ({ recordDir: (id) => `/mock/series/${id}` }),
  getSeries: vi.fn(async (id) => seriesFixture.get(id) || null),
}));

vi.mock('./seriesCanon.js', () => ({
  getSeriesCanon: vi.fn(async () => ({ characters: [{ name: 'Ada' }, { name: 'Bly' }] })),
}));

// Manuscript corpus — driven per-test.
let sectionsFixture = [];
vi.mock('./arcPlanner.js', () => ({
  collectManuscriptSections: vi.fn(async () => sectionsFixture),
  sectionsCorpus: (sections) => sections.map((s) => `# Issue ${s.number}\n\n${s.content}`).join('\n\n---\n\n'),
}));

// Record-event emitter — spied so we can assert generate emits a series
// `updated` event (firing peer-sync) while mergeOutlineFromSync stays silent
// (the echo-loop guard).
const { emitRecordUpdatedMock } = vi.hoisted(() => ({ emitRecordUpdatedMock: vi.fn() }));
vi.mock('../sharing/recordEvents.js', () => ({ emitRecordUpdated: emitRecordUpdatedMock }));

const svc = await import('./reverseOutline.js');

const SERIES_ID = 'ser-abc';

function cannedOutline() {
  return {
    plotlines: [
      { id: 'A', label: 'The heist', kind: 'main' },
      { id: 'B', label: 'Mara & Dov', kind: 'subplot' },
      { id: 'A', label: 'dup id dropped', kind: 'main' }, // duplicate id
    ],
    scenes: [
      {
        issueNumber: 1, heading: 'Opening', summary: 'They meet.', anchorQuote: 'It was dusk',
        povCharacter: 'Ada', plotlineId: 'A', secondaryPlotlineId: 'B',
        components: { narrative: true, action: false, dialogue: true }, setting: 'Pier', charactersPresent: ['Ada', 'Dov'],
      },
      { issueNumber: 1, summary: 'Side beat.', plotlineId: 'Z' }, // unknown plotline → _unassigned
      { nonsense: true }, // dropped (no heading/summary)
    ],
  };
}

beforeEach(() => {
  fileStore.clear();
  emitRecordUpdatedMock.mockClear();
  llmQueue.length = 0;
  llmCalls.length = 0;
  sectionsFixture = [{ issueId: 'iss-1', number: 1, title: 'One', stageId: 'prose', content: 'It was dusk on the pier.' }];
  seriesFixture.clear();
  seriesFixture.set(SERIES_ID, { id: SERIES_ID, name: 'Test Series', styleNotes: 'noir' });
});

describe('generateReverseOutline', () => {
  it('segments, assigns plotline colors, backfills issueId, and routes unknown plotlines to _unassigned', async () => {
    llmQueue.push(cannedOutline());
    const out = await svc.generateReverseOutline(SERIES_ID, {});

    expect(out.status).toBe('complete');
    expect(out.sourceContentHash).toBeTruthy();

    // Duplicate plotline id dropped; colors assigned by index; _unassigned appended.
    const ids = out.plotlines.map((p) => p.id);
    expect(ids).toContain('A');
    expect(ids).toContain('B');
    expect(ids).toContain('_unassigned');
    expect(out.plotlines.find((p) => p.id === 'A').color).toBeTruthy();
    expect(out.plotlines.find((p) => p.id === 'A').color).not.toBe(out.plotlines.find((p) => p.id === 'B').color);

    // Two valid scenes survive; nonsense dropped.
    expect(out.scenes).toHaveLength(2);
    expect(out.scenes[0].id).toBe('scene-001');
    expect(out.scenes[0].issueId).toBe('iss-1'); // backfilled from issueNumber
    expect(out.scenes[0].secondaryPlotlineId).toBe('B');
    expect(out.scenes[1].plotlineId).toBe('_unassigned'); // unknown 'Z' remapped
  });

  it('returns a no-content marker when nothing is drafted', async () => {
    sectionsFixture = [];
    const out = await svc.generateReverseOutline(SERIES_ID, {});
    expect(out.status).toBe('no-content');
    expect(llmCalls).toHaveLength(0);
  });

  it('returns the cached outline when the manuscript is unchanged and not forced', async () => {
    llmQueue.push(cannedOutline());
    await svc.generateReverseOutline(SERIES_ID, {});
    const again = await svc.generateReverseOutline(SERIES_ID, {});
    expect(again.cached).toBe(true);
    expect(llmCalls).toHaveLength(1); // LLM not re-invoked
  });

  it('re-segments when forced even if the manuscript is unchanged', async () => {
    llmQueue.push(cannedOutline(), cannedOutline());
    await svc.generateReverseOutline(SERIES_ID, {});
    await svc.generateReverseOutline(SERIES_ID, { force: true });
    expect(llmCalls).toHaveLength(2);
  });
});

describe('getReverseOutline + staleness', () => {
  it('returns a none shell when never generated but a draft exists', async () => {
    const out = await svc.getReverseOutline(SERIES_ID);
    expect(out.status).toBe('none');
    expect(out.scenes).toEqual([]);
  });

  it('returns no-content (not none) when nothing is drafted yet', async () => {
    sectionsFixture = []; // empty manuscript corpus
    const out = await svc.getReverseOutline(SERIES_ID);
    expect(out.status).toBe('no-content');
    expect(out.scenes).toEqual([]);
  });

  it('flags stale when the manuscript changes after generation', async () => {
    llmQueue.push(cannedOutline());
    await svc.generateReverseOutline(SERIES_ID, {});

    const fresh = await svc.getReverseOutline(SERIES_ID);
    expect(fresh.stale).toBe(false);

    sectionsFixture = [{ issueId: 'iss-1', number: 1, title: 'One', stageId: 'prose', content: 'A completely rewritten draft.' }];
    const stale = await svc.getReverseOutline(SERIES_ID);
    expect(stale.stale).toBe(true);
  });
});

describe('getSceneSegmentation', () => {
  it('exposes the stored scenes + plotlines for downstream checks', async () => {
    llmQueue.push(cannedOutline());
    await svc.generateReverseOutline(SERIES_ID, {});
    const seg = await svc.getSceneSegmentation(SERIES_ID);
    expect(seg.status).toBe('complete');
    expect(seg.scenes).toHaveLength(2);
    expect(seg.plotlines.length).toBeGreaterThan(0);
  });

  it('returns empty when never generated', async () => {
    const seg = await svc.getSceneSegmentation(SERIES_ID);
    expect(seg.status).toBe('none');
    expect(seg.scenes).toEqual([]);
  });
});

describe('sanitizeOutline (pure)', () => {
  const { sanitizeOutline } = svc.__testing;

  it('caps plotlines and clamps strings', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `P${i}`, label: `Plot ${i}`, kind: 'main' }));
    const { plotlines } = sanitizeOutline({ plotlines: many, scenes: [] });
    expect(plotlines.length).toBeLessThanOrEqual(10);
  });

  it('does not append _unassigned when every scene maps cleanly', () => {
    const { plotlines } = sanitizeOutline({
      plotlines: [{ id: 'A', label: 'Main', kind: 'main' }],
      scenes: [{ summary: 'x', plotlineId: 'A' }],
    });
    expect(plotlines.map((p) => p.id)).not.toContain('_unassigned');
  });
});

describe('emits a series updated event on generate (peer-sync trigger)', () => {
  it('fires emitRecordUpdated after a successful generation', async () => {
    llmQueue.push(cannedOutline());
    await svc.generateReverseOutline(SERIES_ID, {});
    expect(emitRecordUpdatedMock).toHaveBeenCalledWith('series', SERIES_ID);
  });

  it('does not emit again when returning a cached (unchanged-manuscript) outline', async () => {
    llmQueue.push(cannedOutline());
    await svc.generateReverseOutline(SERIES_ID, {});
    emitRecordUpdatedMock.mockClear();
    // Same manuscript hash → cached short-circuit, no write, no emit.
    await svc.generateReverseOutline(SERIES_ID, {});
    expect(emitRecordUpdatedMock).not.toHaveBeenCalled();
  });
});

describe('sanitizeSyncedOutline (peer sync)', () => {
  const { sanitizeSyncedOutline } = svc.__testing;

  it('returns null for a non-complete or untimestamped outline', () => {
    expect(sanitizeSyncedOutline({ status: 'none', generatedAt: '2026-06-02T00:00:00Z' })).toBeNull();
    expect(sanitizeSyncedOutline({ status: 'complete' })).toBeNull();
    expect(sanitizeSyncedOutline({ status: 'complete', generatedAt: 'not-a-date' })).toBeNull();
    expect(sanitizeSyncedOutline(null)).toBeNull();
  });

  it('preserves the sender-resolved issue refs instead of recomputing them', () => {
    // Unlike sanitizeOutline (byNumber-driven), the synced sanitizer trusts the
    // issueId/issueTitle the sender already resolved — the receiver may not hold
    // the manuscript.
    const out = sanitizeSyncedOutline({
      status: 'complete', generatedAt: '2026-06-02T00:00:00Z',
      plotlines: [{ id: 'A', label: 'Main', kind: 'main' }],
      scenes: [{ summary: 'A beat.', issueNumber: 3, issueId: 'iss-xyz', issueTitle: 'Chapter Three', plotlineId: 'A' }],
    });
    expect(out.scenes[0].issueId).toBe('iss-xyz');
    expect(out.scenes[0].issueTitle).toBe('Chapter Three');
    expect(out.scenes[0].issueNumber).toBe(3);
  });

  it('drops empty scenes and maps unknown plotlines to _unassigned', () => {
    const out = sanitizeSyncedOutline({
      status: 'complete', generatedAt: '2026-06-02T00:00:00Z',
      plotlines: [{ id: 'A', label: 'Main', kind: 'main' }],
      scenes: [{ summary: 'kept', plotlineId: 'Z' }, { nonsense: true }],
    });
    expect(out.scenes).toHaveLength(1);
    expect(out.scenes[0].plotlineId).toBe('_unassigned');
    expect(out.plotlines.map((p) => p.id)).toContain('_unassigned');
  });
});

describe('mergeOutlineFromSync (whole-doc LWW)', () => {
  const remote = (generatedAt, summary = 'remote') => ({
    status: 'complete', generatedAt,
    plotlines: [{ id: 'A', label: 'Main', kind: 'main' }],
    scenes: [{ summary, plotlineId: 'A' }],
  });

  it('adopts a remote outline when none exists locally', async () => {
    const merged = await svc.mergeOutlineFromSync(SERIES_ID, remote('2026-06-02T00:00:00Z'));
    expect(merged.scenes[0].summary).toBe('remote');
    expect(merged.seriesId).toBe(SERIES_ID);
    // Receive path must NOT emit (echo-loop guard).
    expect(emitRecordUpdatedMock).not.toHaveBeenCalled();
  });

  it('adopts a strictly-newer remote over an older local outline', async () => {
    await svc.mergeOutlineFromSync(SERIES_ID, remote('2026-06-02T00:00:00Z', 'old'));
    const merged = await svc.mergeOutlineFromSync(SERIES_ID, remote('2026-06-03T00:00:00Z', 'new'));
    expect(merged.scenes[0].summary).toBe('new');
  });

  it('keeps the local outline on an equal-clock echo (strict-newer wins)', async () => {
    await svc.mergeOutlineFromSync(SERIES_ID, remote('2026-06-02T00:00:00Z', 'first'));
    const merged = await svc.mergeOutlineFromSync(SERIES_ID, remote('2026-06-02T00:00:00Z', 'echo'));
    expect(merged.scenes[0].summary).toBe('first');
  });

  it('keeps the local outline when the remote is older', async () => {
    await svc.mergeOutlineFromSync(SERIES_ID, remote('2026-06-03T00:00:00Z', 'newer-local'));
    const merged = await svc.mergeOutlineFromSync(SERIES_ID, remote('2026-06-01T00:00:00Z', 'stale-remote'));
    expect(merged.scenes[0].summary).toBe('newer-local');
  });

  it('returns null and writes nothing for a non-propagatable (non-complete) remote', async () => {
    const merged = await svc.mergeOutlineFromSync(SERIES_ID, { status: 'none', generatedAt: '2026-06-02T00:00:00Z' });
    expect(merged).toBeNull();
    expect(await svc.getStoredOutline(SERIES_ID)).toBeNull();
  });
});
