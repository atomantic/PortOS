import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

const fileStore = new Map();
let stageRunnerSpy;

vi.mock('../../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());

// Stub the staged-LLM runner so the test owns the LLM response shape.
// Each test sets `stageRunnerSpy = vi.fn(...)` to control what comes back.
vi.mock('../stageRunner.js', () => ({
  runStagedLLM: vi.fn((...args) => stageRunnerSpy(...args)),
  extractJson: (raw) => JSON.parse(raw),
  // Large window so completeness runs as a single call (mode: 'whole').
  resolveStageContext: vi.fn(() => Promise.resolve({ provider: { id: 'p' }, model: 'm', contextWindow: 1_000_000 })),
}));

const seriesSvc = await import('./series.js');
const planner = await import('./arcPlanner.js');

async function setupSeries(overrides = {}) {
  return seriesSvc.createSeries({
    name: 'Salt Run',
    logline: 'A foundry city goes silent.',
    premise: 'Long-form premise.',
    styleNotes: 'moebius linework',
    issueCountTarget: 24,
    ...overrides,
  });
}

describe('arcPlanner — generateReaderMap', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  it('runs the reader-map prompt and returns a sanitized readerMap', async () => {
    const s = await setupSeries({ arc: { logline: 'rise', summary: 'spine', shape: 'man-in-hole' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        hooks: [{ label: 'Who silenced the foundry?', atArcPosition: 0, note: 'opening' }],
        payoffs: [{ label: 'It was the guild', atArcPosition: 6 }],
        beats: [{ kind: 'bogus', note: 'dropped' }, { kind: 'reveal', atArcPosition: 3, intensity: 9 }],
        cliffhangers: [{ atIssueBoundary: 1, note: 'door opens' }],
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.generateReaderMap(s.id);
    expect(stageRunnerSpy).toHaveBeenCalledWith('story-builder-reader-map', expect.any(Object), expect.objectContaining({ returnsJson: true }));
    expect(out.readerMap.hooks).toHaveLength(1);
    expect(out.readerMap.payoffs[0].atArcPosition).toBe(6);
    // bogus-kind beat dropped, intensity clamped
    expect(out.readerMap.beats).toHaveLength(1);
    expect(out.readerMap.beats[0].intensity).toBe(1);
    expect(out.readerMap.cliffhangers[0].note).toBe('door opens');
  });

  it('is NOT blocked by a locked arc (reader map is authored after the arc is approved)', async () => {
    const s = await setupSeries({ locked: { arc: true }, arc: { logline: 'x', summary: 'y' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { hooks: [{ label: 'h' }], payoffs: [], beats: [], cliffhangers: [] },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const out = await planner.generateReaderMap(s.id);
    expect(out.readerMap.hooks).toHaveLength(1);
  });

  it('throws only when the readerMap field itself is locked', async () => {
    const s = await setupSeries({ locked: { arcFields: { readerMap: true } } });
    await expect(planner.generateReaderMap(s.id)).rejects.toMatchObject({ code: 'PIPELINE_ARC_VALIDATION' });
  });
});

describe('arcPlanner — refineReaderMap', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  it('returns the revised readerMap plus changes and rationale', async () => {
    const s = await setupSeries({
      arc: { logline: 'rise', summary: 'spine', readerMap: { hooks: [{ label: 'old hook' }] } },
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        hooks: [{ label: 'sharper hook', atArcPosition: 0 }],
        payoffs: [],
        beats: [{ kind: 'emotional', intensity: 0.5 }],
        cliffhangers: [],
        changes: ['rewrote the opening hook'],
        rationale: 'tightened the front',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.refineReaderMap(s.id, 'make the first hook sharper');
    expect(stageRunnerSpy).toHaveBeenCalledWith('story-builder-reader-map-refine', expect.any(Object), expect.objectContaining({ returnsJson: true }));
    expect(out.readerMap.hooks[0].label).toBe('sharper hook');
    expect(out.changes).toEqual(['rewrote the opening hook']);
    expect(out.rationale).toBe('tightened the front');
  });

  it('throws when the readerMap field is locked', async () => {
    const s = await setupSeries({ locked: { arcFields: { readerMap: true } } });
    await expect(planner.refineReaderMap(s.id, 'x')).rejects.toMatchObject({ code: 'PIPELINE_ARC_VALIDATION' });
  });

  it('preserves the existing reader map when the LLM returns an empty refinement (non-destructive)', async () => {
    const s = await setupSeries({
      arc: { logline: 'rise', summary: 'spine', readerMap: { hooks: [{ label: 'keep me' }] } },
    });
    // LLM returns nothing usable (only meta) — must NOT null out the map.
    stageRunnerSpy = vi.fn(async () => ({
      content: { hooks: [], payoffs: [], beats: [], cliffhangers: [], changes: [], rationale: 'no change' },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const out = await planner.refineReaderMap(s.id, 'tweak');
    expect(out.readerMap.hooks[0].label).toBe('keep me');
  });

  it('clears changes/rationale when falling back to the existing map (discarded refine)', async () => {
    const s = await setupSeries({
      arc: { logline: 'rise', summary: 'spine', readerMap: { hooks: [{ label: 'keep me' }] } },
    });
    // The LLM authored a change list + rationale but produced an empty map, so
    // the refine is DISCARDED in favor of the existing map. Those changes/
    // rationale describe edits that were never applied and must be cleared —
    // otherwise the UI claims edits it threw away.
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        hooks: [], payoffs: [], beats: [], cliffhangers: [],
        changes: ['rewrote the opening hook', 'added a midpoint payoff'],
        rationale: 'tightened the front',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const out = await planner.refineReaderMap(s.id, 'tweak');
    expect(out.readerMap.hooks[0].label).toBe('keep me');
    expect(out.changes).toEqual([]);
    expect(out.rationale).toBe('');
  });

  it('throws (rather than returns null) when generateReaderMap yields an empty map', async () => {
    const s = await setupSeries({ arc: { logline: 'x', summary: 'y' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { hooks: [], payoffs: [], beats: [], cliffhangers: [] },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    await expect(planner.generateReaderMap(s.id)).rejects.toMatchObject({ code: 'PIPELINE_ARC_VALIDATION' });
  });
});

describe('arcPlanner — refineArc', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  it('returns the revised arc narrative fields plus changes and rationale', async () => {
    const s = await setupSeries({
      arc: { logline: 'old logline', summary: 'old summary', protagonistArc: 'old arc', themes: ['loss'], shape: 'man-in-hole' },
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        logline: 'sharper logline',
        summary: 'sharper summary',
        protagonistArc: 'sharper protagonist arc',
        themes: ['loss', 'redemption'],
        changes: ['sharpened the logline'],
        rationale: 'tightened the spine',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.refineArc(s.id, 'make the logline sharper');
    expect(stageRunnerSpy).toHaveBeenCalledWith('story-builder-arc-refine', expect.any(Object), expect.objectContaining({ returnsJson: true }));
    expect(out.arc.logline).toBe('sharper logline');
    expect(out.arc.summary).toBe('sharper summary');
    expect(out.arc.themes).toEqual(['loss', 'redemption']);
    // shape is narrative-only refine → carried over unchanged.
    expect(out.arc.shape).toBe('man-in-hole');
    expect(out.changes).toEqual(['sharpened the logline']);
    expect(out.rationale).toBe('tightened the spine');
  });

  it('preserves the picked Vonnegut shape and any reader map (narrative-only refine)', async () => {
    const s = await setupSeries({
      arc: {
        logline: 'L', summary: 'S', shape: 'man-in-hole',
        readerMap: { hooks: [{ label: 'keep me' }], payoffs: [], beats: [], cliffhangers: [], status: 'draft' },
      },
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'L2', summary: 'S2', changes: [], rationale: '' },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const out = await planner.refineArc(s.id, 'tweak');
    expect(out.arc.shape).toBe('man-in-hole');
    expect(out.arc.readerMap?.hooks?.[0]?.label).toBe('keep me');
  });

  it('preserves a field the LLM returns empty (refine never blanks existing content)', async () => {
    const s = await setupSeries({ arc: { logline: 'keep logline', summary: 'keep summary', protagonistArc: 'keep arc' } });
    // LLM rewrites the summary but blanks logline + omits protagonistArc — both
    // must fall back to the current values (absent-vs-intentionally-empty rule).
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: '', summary: 'new summary', changes: [], rationale: '' },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const out = await planner.refineArc(s.id, 'tweak the summary');
    expect(out.arc.logline).toBe('keep logline');
    expect(out.arc.summary).toBe('new summary');
    expect(out.arc.protagonistArc).toBe('keep arc');
  });

  it('preserves existing themes when the LLM returns a non-empty but all-blank themes array', async () => {
    // `['  ', null]` is non-empty so a naive length check would accept it, then
    // sanitizeArc cleans it to [] and wipes the user's themes. Must fall back.
    const s = await setupSeries({ arc: { logline: 'L', summary: 'S', themes: ['betrayal', 'hope'] } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'L2', summary: 'S2', themes: ['   ', null], changes: [], rationale: '' },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const out = await planner.refineArc(s.id, 'tweak');
    expect(out.arc.themes).toEqual(['betrayal', 'hope']);
  });

  it('throws when the arc is locked', async () => {
    const s = await setupSeries({ arc: { logline: 'x', summary: 'y' }, locked: { arc: true } });
    await expect(planner.refineArc(s.id, 'x')).rejects.toMatchObject({ code: 'PIPELINE_ARC_VALIDATION' });
  });
});
