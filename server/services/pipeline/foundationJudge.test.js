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
}));
vi.mock('../universeBuilderExpand.js', () => ({
  expandWorldTemplate: vi.fn(async () => ({ logline: 'L2', premise: 'P2', styleNotes: 'S2', influences: null })),
}));
vi.mock('./series.js', async (importActual) => ({
  ...(await importActual()),
  getSeries: vi.fn(async () => ({ id: 'ser-1', name: 'S', logline: 'L', premise: 'P', universeId: 'uni-1' })),
  updateSeries: vi.fn(async (id, patch) => ({ id, ...patch })),
}));
vi.mock('./issues.js', async (importActual) => ({
  ...(await importActual()),
  listIssues: vi.fn(async () => []),
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
const universeBuilderExpand = await import('../universeBuilderExpand.js');
const arcPlanner = await import('./arcPlanner.js');
const issuesSvc = await import('./issues.js');
const {
  judgeFoundation,
  getFoundationJudge,
  computeWeightedScore,
  weakestDimension,
  foundationGateStatus,
  foundationFixTarget,
  sanitizeFoundationJudge,
  isValidFoundationShape,
  isFoundationStale,
  residualFindings,
  applyFoundationFix,
  establishCharacterFoundation,
  thinnestCharacter,
  rankFoundationCharacters,
  seriesFoundationCharacters,
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
  issuesSvc.listIssues.mockResolvedValue([]);
  // Restore the default authored-scalar echo so a test that overrides it (blank
  // /null values) doesn't leak into later order-dependent tests.
  universeBuilderExpand.expandWorldTemplate.mockResolvedValue({ logline: 'L2', premise: 'P2', styleNotes: 'S2', influences: null });
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

describe('foundationGateStatus — weighted threshold + dimension floor', () => {
  it('does not let a strong weighted average hide a critically thin dimension', () => {
    const dimensions = dims({ worldbuilding: 10, character: 5, structure: 10, craft: 10 });
    expect(computeWeightedScore(dimensions)).toBe(8.5);
    expect(foundationGateStatus(dimensions, 8.5, 7.5)).toMatchObject({
      passes: false,
      dimensionFloor: 6,
      failingDimensions: ['character'],
    });
    expect(foundationFixTarget(dimensions, 7.5).dimension).toBe('character');
  });

  it('respects an intentionally lowered threshold as the dimension floor', () => {
    expect(foundationGateStatus(dims({ craft: 4.5 }), 5, 5)).toMatchObject({
      passes: false,
      dimensionFloor: 5,
      failingDimensions: ['craft'],
    });
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
  it('ignores unrelated universe-only characters once the series cast is identifiable', () => {
    const series = { premise: 'Lead crosses the flooded city.' };
    const base = {
      characters: [
        { id: 'lead', name: 'Lead', wound: 'abandoned' },
        { id: 'extra', name: 'Unrelated Extra', wound: '' },
      ],
    };
    const unrelatedEdit = {
      characters: [
        base.characters[0],
        { ...base.characters[1], wound: 'changed outside this series' },
      ],
    };
    expect(foundationInputsHash(series, base)).toBe(foundationInputsHash(series, unrelatedEdit));
    expect(foundationInputsHash(series, base)).not.toBe(foundationInputsHash(series, {
      characters: [{ ...base.characters[0], wound: 'changed in this series' }, base.characters[1]],
    }));
  });
  it('changes when episode synopses, character arcs, or series voice changes', () => {
    const series = {
      seasons: [{ id: 'sea-1', number: 1, synopsis: 'Volume plan' }],
      characterArcs: [{ characterId: 'chr-1', want: 'escape' }],
      styleNotes: 'spare',
    };
    const issue = { id: 'iss-1', seasonId: 'sea-1', number: 1, stages: { idea: { input: 'Opening promise' } } };
    const base = foundationInputsHash(series, null, [issue]);
    expect(foundationInputsHash(series, null, [{ ...issue, stages: { idea: { input: 'Different promise' } } }])).not.toBe(base);
    expect(foundationInputsHash({ ...series, characterArcs: [{ characterId: 'chr-1', want: 'belong' }] }, null, [issue])).not.toBe(base);
    expect(foundationInputsHash({ ...series, styleNotes: 'lyrical' }, null, [issue])).not.toBe(base);
  });
  it('ignores noncanonical visual design assets but tracks narrative influences', () => {
    const base = { logline: 'A city pays for magic with memory.' };
    const withVisualAssets = {
      ...base,
      categories: { rituals: { variations: [{ label: 'The Naming Tax', prompt: 'visual prompt tokens' }] } },
      compositeSheets: [{ id: 'sheet-1', prompt: 'contact sheet prompt tokens' }],
    };
    expect(foundationInputsHash({}, base)).toBe(foundationInputsHash({}, withVisualAssets));
    expect(foundationInputsHash({}, base)).not.toBe(foundationInputsHash({}, {
      ...base,
      influences: { embrace: ['labor songs'], avoid: ['cosmic abstraction'] },
    }));
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

describe('rankFoundationCharacters — core-cast repair targets', () => {
  it('prioritizes authored arcs and synopsis mentions over unrelated blank extras', () => {
    const characters = [
      { id: 'chr-extra', name: 'Extra', role: 'bystander' },
      { id: 'chr-lead', name: 'Lead', role: 'protagonist', wound: 'specific' },
    ];
    const series = { characterArcs: [{ characterId: 'chr-lead', characterName: 'Lead', want: 'win' }] };
    const issues = [{ stages: { idea: { input: 'Lead risks everything.' } } }];
    expect(rankFoundationCharacters(characters, series, issues)[0].character.id).toBe('chr-lead');
  });

  it('keeps every story-referenced character instead of truncating after six', () => {
    const characters = Array.from({ length: 9 }, (_, index) => ({
      id: `chr-${index + 1}`,
      name: `Cast ${index + 1}`,
    }));
    const series = {
      characterArcs: characters.map((character) => ({
        characterId: character.id,
        characterName: character.name,
      })),
    };
    expect(seriesFoundationCharacters(characters, series)).toHaveLength(9);
  });

  it('uses a six-character fallback only before story references exist', () => {
    const characters = Array.from({ length: 9 }, (_, index) => ({
      id: `chr-${index + 1}`,
      name: `Cast ${index + 1}`,
    }));
    expect(seriesFoundationCharacters(characters, {})).toHaveLength(6);
  });
});

describe('renderArc — episode-list budget', () => {
  const bigSeries = {
    arc: { logline: 'AL', summary: 'AS', themes: ['t1'], protagonistArc: 'PA', shape: 'rise' },
    seasons: [{ id: 'sea-1', number: 1, title: 'V1', logline: 'VL', synopsis: 'VS', endingHook: 'EH' }],
    characterArcs: [{ characterId: 'chr-1', characterName: 'Lead', startState: 'a', endState: 'b', want: 'w', need: 'n' }],
  };
  const manyIssues = Array.from({ length: 40 }, (_, i) => ({
    number: i + 1, seasonId: 'sea-1', title: `Ep ${i + 1}`,
    stages: { idea: { input: 'x'.repeat(400) } },
  }));

  it('renders every episode when unbudgeted', () => {
    const out = __testing.renderArc(bigSeries, manyIssues);
    expect(out).toContain('#1 Ep 1:');
    expect(out).toContain('#40 Ep 40:');
    expect(out).not.toContain('omitted to fit the prompt budget');
  });

  it('drops whole trailing episode lines to fit, keeping the plan spine intact', () => {
    const out = __testing.renderArc(bigSeries, manyIssues, { maxChars: 4_000 });
    // Spine survives: arc header, volume logline/synopsis/hook, authored arcs.
    expect(out).toContain('Logline: AL');
    expect(out).toContain('  V1 V1: VL');
    expect(out).toContain('    Synopsis: VS');
    expect(out).toContain('    Ending hook: EH');
    expect(out).toContain('Authored character arcs (1):');
    // Earliest episodes are the ones kept; the tail is dropped by whole lines
    // (never sliced mid-sentence) and the omitted count is named.
    expect(out).toContain('#1 Ep 1:');
    expect(out).not.toContain('#40 Ep 40:');
    expect(out).toMatch(/\[\d+ later episode synopsis lines omitted to fit the prompt budget\]/);
    for (const line of out.split('\n')) {
      if (line.startsWith('    #')) expect(line.endsWith('x'.repeat(20))).toBe(true);
    }
  });

  it('drops every episode rather than throwing when the spine alone overruns the budget', () => {
    const out = __testing.renderArc(bigSeries, manyIssues, { maxChars: 10 });
    expect(out).toContain('Logline: AL');
    expect(out).not.toContain('#1 Ep 1:');
    expect(out).toContain('[40 later episode synopsis lines omitted to fit the prompt budget]');
  });

  it('keeps the singular form when exactly one episode is dropped', () => {
    const oneOver = __testing.renderArc(bigSeries, manyIssues.slice(0, 2), { maxChars: 800 });
    expect(oneOver).toContain('[1 later episode synopsis line omitted to fit the prompt budget]');
  });
});

describe('foundation repair prompt — bounded outline', () => {
  it('caps the synopsis-level plan so the prompt cannot grow without bound with the episode count', async () => {
    seriesSvc.getSeries.mockResolvedValue({
      id: 'ser-1', name: 'S', premise: 'P', universeId: 'uni-1',
      seasons: [{ id: 'sea-1', number: 1, title: 'V1', logline: 'VL', synopsis: 'VS' }],
    });
    issuesSvc.listIssues.mockResolvedValue(Array.from({ length: 60 }, (_, i) => ({
      number: i + 1, seasonId: 'sea-1', title: `Ep ${i + 1}`,
      stages: { idea: { input: 'y'.repeat(500) } },
    })));
    stageRunner.runStagedLLM.mockResolvedValue({
      content: {
        styleGuide: {
          voiceExemplars: [{ passage: 'Example passage.', note: 'example constraint' }],
          voiceAntiExemplars: [{ passage: 'Infinity shimmered.', note: 'generic abstraction' }],
        },
      },
    });

    await applyFoundationFix('ser-1', 'craft', { finding: { gap: 'g', fix: 'f' } });

    const [, vars] = stageRunner.runStagedLLM.mock.calls.at(-1);
    // 60 × ~500 chars of synopsis would be ~30KB unbudgeted — the exact shape
    // that burned both the primary and fallback TUI provider's full timeout.
    expect(vars.outline.length).toBeLessThanOrEqual(__testing.REPAIR_OUTLINE_MAX_CHARS + 200);
    expect(vars.outline).toContain('omitted to fit the prompt budget');
    expect(vars.outline).toContain('  V1 V1: VL');
  });
});

describe('foundation judge context — complete planning altitude', () => {
  it('shows narrative canon but omits noncanonical visual prompt families the repair cannot change', () => {
    const ctx = __testing.buildFoundationContext({
      series: { name: 'Example Series', seasons: [] },
      universe: {
        logline: 'A city pays for magic with memory.',
        premise: 'Every spell erases one shared fact.',
        categories: { rituals: { variations: [{ label: 'The Naming Tax' }] } },
      },
      canon: { characters: [{ id: 'chr-1', name: 'Lead', wound: 'Abandoned during the Naming Tax' }] },
      issues: [],
      contentMax: 30_000,
    });
    expect(ctx.worldEntitiesSummary).toContain('Every spell erases one shared fact.');
    expect(ctx.worldEntitiesSummary).not.toContain('The Naming Tax');
    expect(ctx.characterRoster).toContain('wound: Abandoned during the Naming Tax');
  });

  it('judges the complete story-referenced cast and excludes unrelated universe assets', () => {
    const storyCast = Array.from({ length: 8 }, (_, index) => ({
      id: `chr-${index + 1}`,
      name: `Story Cast ${index + 1}`,
      wound: `Wound ${index + 1}`,
    }));
    const unrelated = { id: 'chr-unrelated', name: 'Universe Only', wound: '' };
    const ctx = __testing.buildFoundationContext({
      series: {
        name: 'Example Series',
        characterArcs: storyCast.map((character) => ({ characterId: character.id })),
        seasons: [],
      },
      universe: {},
      canon: { characters: [...storyCast, unrelated] },
      issues: [],
      contentMax: 30_000,
    });
    expect(ctx.characterCount).toBe(8);
    expect(ctx.characterRoster).toContain('Story Cast 8');
    expect(ctx.characterRoster).not.toContain('Universe Only');
  });

  it('shows authored character transition beats instead of judging endpoints alone', () => {
    const ctx = __testing.buildFoundationContext({
      series: {
        name: 'Example Series',
        seasons: [],
        characterArcs: [{
          characterId: 'chr-1',
          characterName: 'Captain Example',
          want: 'Keep sole command',
          need: 'Become answerable to the crew',
          startState: 'Hides a fatal log entry',
          endState: 'Accepts conditional trust',
          transitions: [{ kind: 'point-of-no-return', atIssue: 7, label: 'Confesses the altered log to the crew and yields crisis authority.' }],
        }],
      },
      universe: {},
      canon: { characters: [{ id: 'chr-1', name: 'Captain Example' }] },
      issues: [],
      contentMax: 30_000,
    });
    expect(ctx.arc).toContain('point-of-no-return (issue 7)');
    expect(ctx.arc).toContain('Confesses the altered log to the crew and yields crisis authority.');
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
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stageRunner.runStagedLLM.mockResolvedValue({
      content: { dimensions: dims({ worldbuilding: 7, character: 7, structure: 7, craft: 7 }), oneLineVerdict: 'v' },
      providerId: 'fallback-y', model: 'fallback-model', runId: 'run-1',
    });
    const out = await judgeFoundation('ser-1', { force: true });
    expect(out.status).toBe('complete');
    expect(out.weightedScore).toBe(7);
    expect(out.sourceInputsHash).toBeTruthy();
    expect(out).toMatchObject({
      providerId: 'fallback-y',
      model: 'fallback-model',
      judgeProviderId: 'judge-x',
      judgeModel: 'jm-heavy',
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('via fallback-y/fallback-model'));
    expect(fileUtils.atomicWrite).toHaveBeenCalled();
    expect(stageRunner.resolveJudgeForStage).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('threads an autopilot critic route as soft defaults so a stage judge pin can win', async () => {
    seriesSvc.getSeries.mockResolvedValue({ id: 'ser-1', name: 'S', universeId: null });
    stageRunner.runStagedLLM.mockResolvedValue({
      content: { dimensions: dims(), oneLineVerdict: 'v' },
      providerId: 'judge-x', model: 'jm-heavy', runId: 'run-soft',
    });

    await judgeFoundation('ser-1', {
      providerDefault: 'codex-tui',
      modelDefault: 'gpt-5.6-sol',
      effortDefault: 'xhigh',
      force: true,
    });

    expect(stageRunner.resolveJudgeForStage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        providerDefault: 'codex-tui',
        modelDefault: 'gpt-5.6-sol',
        providerOverride: undefined,
        modelOverride: undefined,
      }),
    );
    expect(stageRunner.runStagedLLM).toHaveBeenCalledWith(
      'pipeline-judge-foundation',
      expect.anything(),
      expect.objectContaining({ effortDefault: 'xhigh' }),
    );
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

  it('routes character → judge-directed core-cast and character-arc repair', async () => {
    const uni = { id: 'uni-1', characters: [{ id: 'chr-thin', name: 'B' }] };
    universeBuilder.getUniverse.mockResolvedValue(uni);
    universeBuilder.updateUniverse.mockImplementation(async (id, mutator) => ({ id, ...(mutator(uni) || {}) }));
    stageRunner.runStagedLLM.mockResolvedValue({
      content: {
        characters: [{ id: 'chr-thin', name: 'B', ghost: 'A failed rescue', wound: 'Fear of relying on anyone', lie: 'Trust kills', want: 'Work alone', need: 'Accept interdependence', coreTheme: 'trust', motivations: 'Protect the crew without admitting it', speechPattern: 'clipped technical clauses', arcType: 'positive', secrets: ['Caused the original breach'] }],
        characterArcs: [{ characterId: 'chr-thin', characterName: 'B', want: 'Work alone', need: 'Accept interdependence', startState: 'isolated', endState: 'committed to the crew', transitions: [{ kind: 'decision', atIssue: 3, label: 'asks for help' }], status: 'draft' }],
      },
    });
    const r = await applyFoundationFix('ser-1', 'character', { finding: { gap: 'blank lead', fix: 'build the causal chain' } });
    expect(stageRunner.runStagedLLM).toHaveBeenCalledWith('pipeline-character-foundation', expect.objectContaining({
      dimension: 'character',
      phase: 'post-arc reconciliation',
    }), expect.any(Object));
    expect(seriesSvc.updateSeries).toHaveBeenCalledWith('ser-1', expect.objectContaining({ characterArcs: expect.any(Array) }));
    expect(r).toMatchObject({ dimension: 'character', applied: true, characterArcsUpdated: true });
  });

  it('repairs a large referenced cast through exhaustive sequential batches', async () => {
    const characters = Array.from({ length: 8 }, (_, index) => ({
      id: `chr-${index + 1}`,
      name: `Cast ${index + 1}`,
    }));
    const series = {
      id: 'ser-1', name: 'S', premise: 'P', universeId: 'uni-1',
      characterArcs: characters.map((character) => ({
        characterId: character.id,
        characterName: character.name,
      })),
    };
    const uni = { id: 'uni-1', characters };
    seriesSvc.getSeries.mockResolvedValue(series);
    universeBuilder.getUniverse.mockResolvedValue(uni);
    universeBuilder.updateUniverse.mockImplementation(async (id, mutator) => ({ id, ...(mutator(uni) || {}) }));
    stageRunner.runStagedLLM.mockImplementation(async (_stage, vars) => {
      const payload = JSON.parse(vars.charactersJson);
      return {
        content: {
          characters: payload.targetCharacters.map((character) => ({
            ...character,
            ghost: 'A failed rescue', wound: 'Fears dependence', lie: 'Trust kills',
            want: 'Work alone', need: 'Choose interdependence', coreTheme: 'trust',
            motivations: 'Protect the crew', speechPattern: 'clipped clauses',
            arcType: 'positive', secrets: ['Caused the breach'],
          })),
        },
      };
    });

    const r = await applyFoundationFix('ser-1', 'character', {
      finding: { gap: 'incomplete ensemble', fix: 'complete every referenced character' },
    });

    const calls = stageRunner.runStagedLLM.mock.calls
      .filter(([stage]) => stage === 'pipeline-character-foundation');
    expect(calls).toHaveLength(2);
    expect(calls.map(([, vars]) => JSON.parse(vars.charactersJson).targetCharacters.length)).toEqual([6, 2]);
    expect(calls.every(([, vars]) => JSON.parse(vars.charactersJson).fullSeriesRoster.length === 8)).toBe(true);
    const secondRoster = JSON.parse(calls[1][1].charactersJson).fullSeriesRoster;
    expect(secondRoster.find((character) => character.id === 'chr-1').wound).toBe('Fears dependence');
    expect(r).toMatchObject({ applied: true, entryIds: characters.map((character) => character.id) });
  });

  it('adds a genuinely missing story character and links its authored arc', async () => {
    const uni = { id: 'uni-1', characters: [] };
    seriesSvc.getSeries.mockResolvedValue({
      id: 'ser-1', name: 'S', logline: 'L', premise: 'P', universeId: 'uni-1',
      characterArcs: [{
        characterName: 'The Foil', want: 'Control the expedition', need: 'Share authority',
        startState: 'guarded', endState: 'tentatively collaborative', transitions: [], status: 'draft',
      }],
    });
    universeBuilder.getUniverse.mockResolvedValue(uni);
    universeBuilder.updateUniverse.mockImplementation(async (id, mutator) => ({ id, ...(mutator(uni) || {}) }));
    stageRunner.runStagedLLM.mockResolvedValue({
      content: {
        newCharacters: [{
          name: 'The Foil', role: 'antagonistic confidant',
          ghost: 'Abandoned during an evacuation', wound: 'Equates dependence with danger',
          lie: 'Only control prevents loss', want: 'Control the expedition', need: 'Share authority',
          coreTheme: 'control versus trust', motivations: 'Protect the crew and prove indispensability',
          speechPattern: 'measured questions that conceal commands', arcType: 'positive',
          secrets: ['Withheld the failed route data'], relationships: 'Needs the lead and resents needing them',
        }],
        characterArcs: [{
          characterName: 'The Foil', want: 'Control the expedition', need: 'Share authority',
          startState: 'controlling', endState: 'collaborative',
          transitions: [{ kind: 'sacrifice', atIssue: 8, label: 'cedes the decisive vote' }],
        }],
      },
    });
    const r = await applyFoundationFix('ser-1', 'character', { finding: { gap: 'missing foil', fix: 'add the required foil' } });
    expect(r).toMatchObject({ dimension: 'character', applied: true, charactersAdded: 1, characterArcsUpdated: true });
    const seriesPatch = seriesSvc.updateSeries.mock.calls.at(-1)[1];
    expect(seriesPatch.characterArcs).toHaveLength(1);
    expect(seriesPatch.characterArcs[0]).toMatchObject({ characterName: 'The Foil' });
    expect(seriesPatch.characterArcs[0].characterId).toMatch(/^chr-/);
  });

  it('establishes the character foundation before an arc exists', async () => {
    const uni = { id: 'uni-1', characters: [{ id: 'chr-thin', name: 'Lead', role: 'protagonist' }] };
    universeBuilder.getUniverse.mockResolvedValue(uni);
    universeBuilder.updateUniverse.mockImplementation(async (id, mutator) => ({ id, ...(mutator(uni) || {}) }));
    stageRunner.runStagedLLM.mockResolvedValue({ content: {
      characters: [{
        id: 'chr-thin', name: 'Lead', ghost: 'A rescue failed', wound: 'Fears relying on others',
        lie: 'Trust creates casualties', want: 'Act alone', need: 'Choose interdependence',
        coreTheme: 'trust', motivations: 'Protect others while hiding fear',
        speechPattern: 'clipped observations', arcType: 'positive', secrets: ['Caused the failure'],
      }],
      characterArcs: [{
        characterId: 'chr-thin', characterName: 'Lead', want: 'Act alone', need: 'Choose interdependence',
        startState: 'isolated', endState: 'connected',
        transitions: [{ kind: 'decision', atIssue: 2, label: 'asks for help' }],
      }],
    } });
    const r = await establishCharacterFoundation('ser-1', { providerDefault: 'codex', modelDefault: 'gpt-x', effortDefault: 'high' });
    expect(r).toMatchObject({ ran: true, applied: true });
    expect(stageRunner.runStagedLLM).toHaveBeenCalledWith('pipeline-character-foundation', expect.objectContaining({
      phase: 'pre-arc character foundation',
    }), expect.objectContaining({ providerDefault: 'codex', modelDefault: 'gpt-x', effortDefault: 'high' }));
  });

  it('routes worldbuilding → expandWorldTemplate + a lock-aware updateUniverse write', async () => {
    const uni = { id: 'uni-1', name: 'U' };
    universeBuilder.getUniverse.mockResolvedValue(uni);
    let writtenPatch = null;
    universeBuilder.updateUniverse.mockImplementation(async (id, m) => { writtenPatch = typeof m === 'function' ? m(uni) : m; return { id, ...(writtenPatch || {}) }; });
    const r = await applyFoundationFix('ser-1', 'worldbuilding', {
      finding: { gap: 'costless magic', fix: 'make memory the price' },
      providerOverride: 'codex-tui',
      modelOverride: 'gpt-5.6-sol',
      effortOverride: 'ultra',
    });
    expect(universeBuilderExpand.expandWorldTemplate).toHaveBeenCalledWith(expect.objectContaining({
      starterPrompt: 'U',
      foundationDirective: expect.stringContaining('costless magic'),
      providerId: 'codex-tui',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      narrativeOnly: true,
    }));
    expect(writtenPatch).toMatchObject({ logline: 'L2', premise: 'P2', styleNotes: 'S2' });
    expect(r).toMatchObject({ dimension: 'worldbuilding', applied: true });
  });

  it('worldbuilding refine DROPS a human-locked field from the write (never clobbers locked canon)', async () => {
    const uni = { id: 'uni-1', name: 'U', locked: { logline: true } };
    universeBuilder.getUniverse.mockResolvedValue(uni);
    let writtenPatch = null;
    universeBuilder.updateUniverse.mockImplementation(async (id, m) => { writtenPatch = typeof m === 'function' ? m(uni) : m; return { id, ...(writtenPatch || {}) }; });
    const r = await applyFoundationFix('ser-1', 'worldbuilding', {});
    // logline is locked → the refreshed logline must NOT be in the write patch.
    expect(writtenPatch).not.toHaveProperty('logline');
    expect(writtenPatch).toMatchObject({ premise: 'P2', styleNotes: 'S2' });
    expect(r.applied).toBe(true);
  });

  it('worldbuilding refine OMITS an unlocked field the LLM returned blank/null (preserves existing, no erase)', async () => {
    const uni = { id: 'uni-1', name: 'U' };
    universeBuilder.getUniverse.mockResolvedValue(uni);
    // LLM omitted logline (null) and returned an empty premise → neither should
    // be written; only the authored styleNotes lands.
    universeBuilderExpand.expandWorldTemplate.mockResolvedValue({ logline: null, premise: '   ', styleNotes: 'S2', influences: null });
    let writtenPatch = null;
    universeBuilder.updateUniverse.mockImplementation(async (id, m) => { writtenPatch = typeof m === 'function' ? m(uni) : m; return { id, ...(writtenPatch || {}) }; });
    const r = await applyFoundationFix('ser-1', 'worldbuilding', {});
    expect(writtenPatch).not.toHaveProperty('logline');
    expect(writtenPatch).not.toHaveProperty('premise');
    expect(writtenPatch).toMatchObject({ styleNotes: 'S2' });
    expect(r.applied).toBe(true);
  });

  it('worldbuilding refine reports applied:false when EVERY refinable field is locked', async () => {
    const uni = { id: 'uni-1', name: 'U', locked: { logline: true, premise: true, styleNotes: true, influencesEmbrace: true, influencesAvoid: true } };
    universeBuilder.getUniverse.mockResolvedValue(uni);
    universeBuilderExpand.expandWorldTemplate.mockResolvedValue({ logline: 'L2', premise: 'P2', styleNotes: 'S2', influences: { embrace: ['x'], avoid: [] } });
    universeBuilder.updateUniverse.mockImplementation(async (id, m) => { const p = typeof m === 'function' ? m(uni) : m; return p === null ? { id } : { id, ...p }; });
    const r = await applyFoundationFix('ser-1', 'worldbuilding', {});
    expect(r).toMatchObject({ dimension: 'worldbuilding', applied: false });
  });

  it('worldbuilding refine does NOT write influences when a sublist is locked (influencesAvoid)', async () => {
    // Only the influence sublists are lockable; `influences` is replaced
    // wholesale, so a locked avoid-list must block the whole influences write.
    const uni = { id: 'uni-1', name: 'U', locked: { influencesAvoid: true } };
    universeBuilder.getUniverse.mockResolvedValue(uni);
    universeBuilderExpand.expandWorldTemplate.mockResolvedValue({ logline: 'L2', premise: 'P2', styleNotes: 'S2', influences: { embrace: ['new'], avoid: ['clobber'] } });
    let writtenPatch = null;
    universeBuilder.updateUniverse.mockImplementation(async (id, m) => { writtenPatch = typeof m === 'function' ? m(uni) : m; return { id, ...(writtenPatch || {}) }; });
    const r = await applyFoundationFix('ser-1', 'worldbuilding', {});
    expect(writtenPatch).not.toHaveProperty('influences');
    // the unlocked scalars still land
    expect(writtenPatch).toMatchObject({ logline: 'L2', premise: 'P2', styleNotes: 'S2' });
    expect(r.applied).toBe(true);
  });

  it('routes craft → series voice repair with concrete exemplars', async () => {
    stageRunner.runStagedLLM.mockResolvedValue({
      content: {
        styleNotes: 'Close third-person, spare and salt-dry, with dialogue that circles grief instead of naming it.',
        styleGuide: {
          tense: 'past',
          povPerson: 'third-limited',
          targetAudience: 'adult',
          contentRating: 'PG-13',
          voiceExemplars: [{ passage: 'The bell moved before the wind did.', note: 'compressed sensory unease' }],
          voiceAntiExemplars: [{ passage: 'A mysterious feeling filled the air.', note: 'generic abstraction' }],
        },
      },
    });
    const r = await applyFoundationFix('ser-1', 'craft', { finding: { gap: 'generic voice', fix: 'add tuning forks' } });
    expect(universeBuilderExpand.expandWorldTemplate).not.toHaveBeenCalled();
    expect(seriesSvc.updateSeries).toHaveBeenCalledWith('ser-1', expect.objectContaining({
      styleNotes: expect.stringContaining('Close third-person'),
      styleGuide: expect.objectContaining({ voiceExemplars: expect.any(Array) }),
    }));
    expect(r).toMatchObject({ dimension: 'craft', applied: true });
  });

  it('retries an oversized craft proposal instead of silently truncating its evidence', async () => {
    stageRunner.runStagedLLM
      .mockResolvedValueOnce({
        content: {
          styleGuide: {
            voiceExemplars: [{ passage: 'x'.repeat(2_001), note: 'too long to persist intact' }],
            voiceAntiExemplars: [{ passage: 'Flat prose.', note: 'generic' }],
          },
        },
      })
      .mockResolvedValueOnce({
        content: {
          styleNotes: 'Concrete, controlled omniscience.',
          styleGuide: {
            voiceExemplars: [{ passage: 'The bell moved. Captain Example felt its answer in the rope.', note: 'complete material handoff' }],
            voiceAntiExemplars: [{ passage: 'Infinity shimmered sadly.', note: 'unearned abstraction' }],
          },
        },
      });

    const r = await applyFoundationFix('ser-1', 'craft', { finding: { gap: 'truncated proof', fix: 'complete the relay' } });

    expect(stageRunner.runStagedLLM).toHaveBeenCalledTimes(2);
    const firstFinding = JSON.parse(stageRunner.runStagedLLM.mock.calls[0][1].foundationFindingJson);
    const retryFinding = JSON.parse(stageRunner.runStagedLLM.mock.calls[1][1].foundationFindingJson);
    expect(firstFinding.hardStorageContract).toMatchObject({ passageMaxChars: 2_000, noteMaxChars: 200 });
    expect(retryFinding.retryReason).toMatch(/exceeds 2000 characters/);
    expect(seriesSvc.updateSeries).toHaveBeenCalledWith('ser-1', expect.objectContaining({
      styleGuide: expect.objectContaining({
        voiceExemplars: [expect.objectContaining({ passage: expect.stringContaining('Captain Example felt') })],
      }),
    }));
    expect(r).toMatchObject({ dimension: 'craft', applied: true });
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
