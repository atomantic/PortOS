import { describe, it, expect, vi, beforeEach } from 'vitest';

// I/O is the only thing mocked in fileUtils — PATHS/safeJSONParse stay real so
// the snapshot round-trip logic runs against the actual parser.
vi.mock('../../lib/fileUtils.js', async (importActual) => ({
  ...(await importActual()),
  tryReadFile: vi.fn(async () => null),
  atomicWrite: vi.fn(async () => {}),
  ensureDir: vi.fn(async () => {}),
}));

vi.mock('../../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn(),
  resolveStageContext: vi.fn(async () => ({ contextWindow: 200_000 })),
  resolveJudgeForStage: vi.fn(async () => ({ provider: { id: 'judge-x' }, model: 'jm-heavy' })),
}));

vi.mock('../promptService.js', () => ({ getStage: vi.fn(() => ({ name: 'writer' })) }));
vi.mock('../universeBuilder.js', () => ({
  getUniverse: vi.fn(async () => null),
  updateUniverse: vi.fn(async (id, patch) => ({ id, ...patch })),
}));
vi.mock('../universeCharacterExpand.js', async (importActual) => ({
  ...(await importActual()),
  expandUniverseCharacter: vi.fn(async () => ({ updatedFields: ['wound'] })),
}));
vi.mock('../universeBuilderExpand.js', () => ({
  expandWorldTemplate: vi.fn(async () => ({ logline: 'L2', premise: 'P2', styleNotes: 'S2', influences: null })),
}));
vi.mock('./series.js', async (importActual) => ({
  ...(await importActual()),
  getSeries: vi.fn(async () => ({ id: 'ser-1', name: 'S', logline: 'L', premise: 'P', universeId: 'uni-1' })),
}));
vi.mock('./seriesCanon.js', async (importActual) => ({
  ...(await importActual()),
  getSeriesCanon: vi.fn(async () => ({ characters: [] })),
}));
vi.mock('./arcPlanner.js', async (importActual) => ({
  ...(await importActual()),
  resolveVerifyIssues: vi.fn(async () => ({ applied: true })),
}));

const fileUtils = await import('../../lib/fileUtils.js');
const stageRunner = await import('../../lib/stageRunner.js');
const seriesSvc = await import('./series.js');
const universeBuilder = await import('../universeBuilder.js');
const universeCharacterExpand = await import('../universeCharacterExpand.js');
const universeBuilderExpand = await import('../universeBuilderExpand.js');
const arcPlanner = await import('./arcPlanner.js');
const {
  judgeFoundation,
  getFoundationJudge,
  computeWeightedScore,
  weakestDimension,
  sanitizeFoundationJudge,
  isValidFoundationShape,
  isFoundationStale,
  residualFindings,
  applyFoundationFix,
  thinnestCharacter,
  foundationInputsHash,
  FOUNDATION_DIMENSIONS,
  FOUNDATION_WEIGHTS,
  DEFAULT_FOUNDATION_THRESHOLD,
  __testing,
} = await import('./foundationJudge.js');

const dims = (scores = {}) => Object.fromEntries(
  FOUNDATION_DIMENSIONS.map((k) => [k, { score: scores[k] ?? 6, gap: `gap ${k}`, fix: `fix ${k}` }]),
);

beforeEach(() => {
  vi.clearAllMocks();
  fileUtils.tryReadFile.mockResolvedValue(null);
  stageRunner.resolveStageContext.mockResolvedValue({ contextWindow: 200_000 });
  stageRunner.resolveJudgeForStage.mockResolvedValue({ provider: { id: 'judge-x' }, model: 'jm-heavy' });
  seriesSvc.getSeries.mockResolvedValue({ id: 'ser-1', name: 'S', logline: 'L', premise: 'P', universeId: 'uni-1' });
  universeBuilder.getUniverse.mockResolvedValue(null);
});

describe('computeWeightedScore — weighted composite', () => {
  it('weights the four dimensions 40/30/20/10', () => {
    // all 10 → 10; all 5 → 5
    expect(computeWeightedScore(dims({ worldbuilding: 10, character: 10, structure: 10, craft: 10 }))).toBe(10);
    expect(computeWeightedScore(dims({ worldbuilding: 5, character: 5, structure: 5, craft: 5 }))).toBe(5);
  });
  it('applies the exact weights', () => {
    // worldbuilding 10 (×.4=4), rest 0 → 4.0
    expect(computeWeightedScore(dims({ worldbuilding: 10, character: 0, structure: 0, craft: 0 }))).toBe(4);
    // craft 10 (×.1=1), rest 0 → 1.0
    expect(computeWeightedScore(dims({ worldbuilding: 0, character: 0, structure: 0, craft: 10 }))).toBe(1);
  });
  it('treats a missing/invalid dimension as 0 (never NaN-poisons)', () => {
    expect(computeWeightedScore({})).toBe(0);
    expect(computeWeightedScore(null)).toBe(0);
    expect(computeWeightedScore({ worldbuilding: { score: 'oops' } })).toBe(0);
  });
  it('the weights sum to 1', () => {
    expect(FOUNDATION_DIMENSIONS.reduce((n, d) => n + FOUNDATION_WEIGHTS[d], 0)).toBeCloseTo(1, 9);
  });
});

describe('weakestDimension — leverage-based target', () => {
  it('picks the largest weighted deficit, not the bare lowest score', () => {
    // worldbuilding 5 (deficit .4×5=2.0) beats craft 4 (deficit .1×6=0.6)
    const w = weakestDimension(dims({ worldbuilding: 5, character: 8, structure: 8, craft: 4 }));
    expect(w.dimension).toBe('worldbuilding');
  });
  it('breaks ties toward the lower raw score', () => {
    // structure 5 (deficit .2×5=1.0) vs character ~6.67 gives same deficit? construct a real tie:
    // character 6 → .3×4=1.2 ; structure 4 → .2×6=1.2 (tie) → lower score (structure 4) wins
    const w = weakestDimension(dims({ worldbuilding: 10, character: 6, structure: 4, craft: 10 }));
    expect(w.dimension).toBe('structure');
  });
  it('returns null when no dimension is present', () => {
    expect(weakestDimension({})).toBeNull();
  });
});

describe('sanitizeFoundationJudge — defensive LLM output shaping', () => {
  it('coerces every dimension to { score, gap, fix } and computes the weighted score', () => {
    const out = sanitizeFoundationJudge({ dimensions: dims({ worldbuilding: 8 }), oneLineVerdict: 'ok' });
    for (const d of FOUNDATION_DIMENSIONS) {
      expect(out.dimensions[d]).toMatchObject({ score: expect.any(Number), gap: expect.any(String), fix: expect.any(String) });
    }
    expect(out.weightedScore).toBeCloseTo(computeWeightedScore(out.dimensions), 5);
    expect(out.oneLineVerdict).toBe('ok');
  });
  it('clamps scores to [0,10] and fills missing dimensions with 0', () => {
    const out = sanitizeFoundationJudge({ dimensions: { worldbuilding: { score: 99 } } });
    expect(out.dimensions.worldbuilding.score).toBe(10);
    expect(out.dimensions.character.score).toBe(0);
  });
  it('isValidFoundationShape requires a dimensions object', () => {
    expect(isValidFoundationShape({ dimensions: {} })).toBe(true);
    expect(isValidFoundationShape({ oneLineVerdict: 'x' })).toBe(false);
    expect(isValidFoundationShape(null)).toBe(false);
  });
});

describe('residualFindings — pause payload shape', () => {
  it('emits one { severity, location, problem, suggestion } per dimension', () => {
    const findings = residualFindings(dims({ worldbuilding: 3 }));
    expect(findings).toHaveLength(FOUNDATION_DIMENSIONS.length);
    expect(findings[0]).toMatchObject({ severity: 'high', problem: expect.any(String) });
    expect(findings[0].location).toMatch(/worldbuilding/);
  });
});

describe('foundationInputsHash + staleness — fast-pass pinning', () => {
  it('is stable when inputs are unchanged and changes when the arc changes', () => {
    const series = { arc: { logline: 'A' }, seasons: [] };
    const h1 = foundationInputsHash(series, null);
    const h2 = foundationInputsHash({ arc: { logline: 'A' }, seasons: [] }, null);
    const h3 = foundationInputsHash({ arc: { logline: 'B' }, seasons: [] }, null);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
  it('changes when a character framework field changes', () => {
    const uni1 = { characters: [{ id: 'c1', name: 'Ana', wound: '' }] };
    const uni2 = { characters: [{ id: 'c1', name: 'Ana', wound: 'abandoned as a child' }] };
    expect(foundationInputsHash({}, uni1)).not.toBe(foundationInputsHash({}, uni2));
  });
  it('isFoundationStale flags a complete snapshot whose pinned hash drifted', () => {
    expect(isFoundationStale({ status: 'complete', sourceInputsHash: 'a' }, 'b')).toBe(true);
    expect(isFoundationStale({ status: 'complete', sourceInputsHash: 'a' }, 'a')).toBe(false);
    expect(isFoundationStale({ status: 'pending' }, 'b')).toBe(false);
    expect(isFoundationStale(null, 'b')).toBe(false);
  });
});

describe('thinnestCharacter — character fix target', () => {
  it('picks the unlocked character missing the most framework fields', () => {
    const chars = [
      { id: 'full', name: 'A', ghost: 'g', wound: 'w', lie: 'l', want: 'wa', need: 'n', coreTheme: 't', motivations: 'm', speechPattern: 's', arcType: 'positive', secrets: ['x'] },
      { id: 'thin', name: 'B' }, // all blank
      { id: 'mid', name: 'C', wound: 'w', lie: 'l' },
    ];
    expect(thinnestCharacter(chars)).toBe('thin');
  });
  it('skips locked characters (locked = constraint, not target)', () => {
    const chars = [{ id: 'locked', name: 'A', locked: true }, { id: 'ok', name: 'B', wound: 'w' }];
    expect(thinnestCharacter(chars)).toBe('ok');
  });
  it('returns null when every character is complete or locked', () => {
    expect(thinnestCharacter([{ id: 'locked', name: 'A', locked: true }])).toBeNull();
    expect(thinnestCharacter([])).toBeNull();
  });
});

describe('judgeFoundation — cache / fast-pass', () => {
  it('returns the cached snapshot without an LLM call when the inputs hash matches', async () => {
    const series = { id: 'ser-1', name: 'S', universeId: null };
    seriesSvc.getSeries.mockResolvedValue(series);
    const hash = foundationInputsHash(series, null);
    fileUtils.tryReadFile.mockResolvedValue(JSON.stringify({
      seriesId: 'ser-1', status: 'complete', sourceInputsHash: hash, weightedScore: 8, dimensions: dims(),
    }));
    const out = await judgeFoundation('ser-1');
    expect(out.cached).toBe(true);
    expect(stageRunner.runStagedLLM).not.toHaveBeenCalled();
  });

  it('runs the judge (writer/judge split) and persists a hashed snapshot on a fresh foundation', async () => {
    seriesSvc.getSeries.mockResolvedValue({ id: 'ser-1', name: 'S', universeId: null });
    stageRunner.runStagedLLM.mockResolvedValue({
      content: { dimensions: dims({ worldbuilding: 7, character: 7, structure: 7, craft: 7 }), oneLineVerdict: 'v' },
      providerId: 'judge-x', model: 'jm-heavy', runId: 'run-1',
    });
    const out = await judgeFoundation('ser-1', { force: true });
    expect(out.status).toBe('complete');
    expect(out.weightedScore).toBe(7);
    expect(out.sourceInputsHash).toBeTruthy();
    expect(fileUtils.atomicWrite).toHaveBeenCalled();
    expect(stageRunner.resolveJudgeForStage).toHaveBeenCalled();
  });
});

describe('applyFoundationFix — dimension → owning-service routing table', () => {
  it('routes structure → arc resolve (resolveVerifyIssues) with a synthesized finding', async () => {
    const r = await applyFoundationFix('ser-1', 'structure', { finding: { gap: 'thin midpoint', fix: 'add a reversal' } });
    expect(arcPlanner.resolveVerifyIssues).toHaveBeenCalledWith('ser-1', expect.objectContaining({
      findings: expect.arrayContaining([expect.objectContaining({ location: 'arc', problem: 'thin midpoint' })]),
    }));
    expect(r).toMatchObject({ dimension: 'structure', applied: true });
  });

  it('routes character → expandUniverseCharacter on the thinnest unlocked character', async () => {
    universeBuilder.getUniverse.mockResolvedValue({ id: 'uni-1', characters: [{ id: 'thin', name: 'B' }] });
    const r = await applyFoundationFix('ser-1', 'character', {});
    expect(universeCharacterExpand.expandUniverseCharacter).toHaveBeenCalledWith('uni-1', 'thin', expect.any(Object));
    expect(r).toMatchObject({ dimension: 'character', applied: true, entryId: 'thin' });
  });

  it('routes worldbuilding → expandWorldTemplate + updateUniverse (locked echoed, no clobber)', async () => {
    universeBuilder.getUniverse.mockResolvedValue({ id: 'uni-1', name: 'U', locked: { logline: true } });
    const r = await applyFoundationFix('ser-1', 'worldbuilding', {});
    expect(universeBuilderExpand.expandWorldTemplate).toHaveBeenCalledWith(expect.objectContaining({ locked: { logline: true } }));
    expect(universeBuilder.updateUniverse).toHaveBeenCalled();
    expect(r).toMatchObject({ dimension: 'worldbuilding', applied: true });
  });

  it('routes craft → the same universe world refine as worldbuilding', async () => {
    universeBuilder.getUniverse.mockResolvedValue({ id: 'uni-1', name: 'U' });
    await applyFoundationFix('ser-1', 'craft', {});
    expect(universeBuilderExpand.expandWorldTemplate).toHaveBeenCalled();
  });

  it('reports applied:false (not a throw) when a world fix has no linked universe', async () => {
    seriesSvc.getSeries.mockResolvedValue({ id: 'ser-1', name: 'S', universeId: null });
    const r = await applyFoundationFix('ser-1', 'worldbuilding', {});
    expect(r).toMatchObject({ dimension: 'worldbuilding', applied: false });
  });

  it('reports applied:false (not a throw) for structure when the arc is locked', async () => {
    seriesSvc.getSeries.mockResolvedValue({ id: 'ser-1', name: 'S', universeId: 'uni-1', locked: { arc: true } });
    const r = await applyFoundationFix('ser-1', 'structure', { finding: { gap: 'g', fix: 'f' } });
    expect(arcPlanner.resolveVerifyIssues).not.toHaveBeenCalled();
    expect(r).toMatchObject({ dimension: 'structure', applied: false });
  });

  it('reports applied:false for character when no unlocked blank character exists', async () => {
    universeBuilder.getUniverse.mockResolvedValue({ id: 'uni-1', characters: [{ id: 'locked', name: 'A', locked: true }] });
    const r = await applyFoundationFix('ser-1', 'character', {});
    expect(r.applied).toBe(false);
  });
});

describe('DEFAULT_FOUNDATION_THRESHOLD', () => {
  it('mirrors autonovel\'s 7.5 foundation bar', () => {
    expect(DEFAULT_FOUNDATION_THRESHOLD).toBe(7.5);
  });
});
