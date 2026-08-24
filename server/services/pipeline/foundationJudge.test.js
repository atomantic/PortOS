import { describe, it, expect, vi, beforeEach } from 'vitest';

// I/O is the only thing mocked in fileUtils — PATHS/safeJSONParse stay real so
// the snapshot round-trip logic runs against the actual parser.
vi.mock('../../lib/fileUtils.js', async (importActual) => ({
  ...(await importActual()),
  tryReadFile: vi.fn(async () => null),
  atomicWrite: vi.fn(async () => {}),
  ensureDir: vi.fn(async () => {}),
}));

vi.mock('../stageRunner.js', () => ({
  runStagedLLM: vi.fn(),
  resolveStageContext: vi.fn(async () => ({ contextWindow: 200_000 })),
  resolveJudgeForStage: vi.fn(async () => ({ provider: { id: 'judge-x' }, model: 'jm-heavy' })),
}));

vi.mock('../promptService.js', () => ({ getStage: vi.fn(() => ({ name: 'writer' })) }));
// Storage is stubbed; the record-shape layer is real. `universeBuilder/sanitize.js`
// is the pure constants+sanitizers half of the barrel (no storage, no peer-sync),
// so pulling it in keeps the real LOGLINE_MAX/PREMISE_MAX/STYLE_NOTES_MAX the
// narrative write budget is derived from instead of a mock copy that can drift.
vi.mock('../universeBuilder.js', async () => ({
  ...(await import('../universeBuilder/sanitize.js')),
  getUniverse: vi.fn(async () => null),
  updateUniverse: vi.fn(async (id, patch) => ({ id, ...patch })),
}));
vi.mock('../universeCharacterExpand.js', async (importActual) => ({
  ...(await importActual()),
}));
// Only the LLM round-trip is mocked. `narrativeRepairTargets` is pure write-budget
// math the world repair reports saturation from — re-implementing it in the mock
// would make these tests agree with a copy instead of the real contract.
vi.mock('../universeBuilderExpand.js', async (importActual) => ({
  ...(await importActual()),
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
  restoreArcState: vi.fn(async () => ({ restored: true })),
  snapshotArcState: vi.fn(async () => ({ seriesId: 'ser-1', arc: {}, seasons: [], episodes: [] })),
  verifyArc: vi.fn(async () => ({ issues: [] })),
}));

const fileUtils = await import('../../lib/fileUtils.js');
const stageRunner = await import('../stageRunner.js');
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
  snapshotFoundationState,
  restoreFoundationState,
  applyFoundationFix,
  establishCharacterFoundation,
  thinnestCharacter,
  rankFoundationCharacters,
  seriesFoundationCharacters,
  countFoundationCharacterBlanks,
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
  arcPlanner.resolveVerifyIssues.mockResolvedValue({ applied: true });
  arcPlanner.restoreArcState.mockResolvedValue({ restored: true });
  arcPlanner.snapshotArcState.mockResolvedValue({ seriesId: 'ser-1', arc: {}, seasons: [], episodes: [] });
  arcPlanner.verifyArc.mockResolvedValue({ issues: [] });
  // Restore the default authored-scalar echo so a test that overrides it (blank
  // /null values) doesn't leak into later order-dependent tests.
  universeBuilderExpand.expandWorldTemplate.mockResolvedValue({ logline: 'L2', premise: 'P2', styleNotes: 'S2', influences: null });
});

describe('foundation repair checkpoint', () => {
  it('restores and verifies world, character, craft, arc, volume, and issue-seed state', async () => {
    let seriesState = {
      id: 'ser-1', universeId: 'uni-1', styleNotes: 'voice before',
      styleGuide: { tone: ['spare'] }, characterArcs: [{ characterName: 'Example Lead' }],
    };
    let universeState = {
      id: 'uni-1', logline: 'world before', premise: 'rules before', styleNotes: 'style before',
      influences: { embrace: ['Example'], avoid: [] },
      characters: [{ id: 'chr-1', name: 'Example Lead', need: 'trust' }],
    };
    let arcState = {
      seriesId: 'ser-1', arc: { summary: 'arc before' },
      seasons: [{ id: 'sea-1', synopsis: 'volume before' }],
      episodes: [{ id: 'iss-1', seasonId: 'sea-1', idea: { input: 'seed before', output: '', status: 'ready' } }],
    };
    seriesSvc.getSeries.mockImplementation(async () => structuredClone(seriesState));
    seriesSvc.updateSeries.mockImplementationOnce(async (_id, patch) => {
      seriesState = { ...seriesState, ...structuredClone(patch) };
      return structuredClone(seriesState);
    });
    universeBuilder.getUniverse.mockImplementation(async () => structuredClone(universeState));
    universeBuilder.updateUniverse.mockImplementationOnce(async (_id, patch) => {
      universeState = { ...universeState, ...structuredClone(patch) };
      return structuredClone(universeState);
    });
    arcPlanner.snapshotArcState.mockImplementation(async () => structuredClone(arcState));
    arcPlanner.restoreArcState.mockImplementation(async (_id, snapshot) => {
      arcState = structuredClone(snapshot);
      return { restored: true, episodesRestored: 1 };
    });

    const checkpoint = await snapshotFoundationState('ser-1');
    seriesState = { ...seriesState, styleNotes: 'voice after', characterArcs: [] };
    universeState = { ...universeState, premise: 'rules after', characters: [] };
    arcState = { ...arcState, arc: { summary: 'arc after' }, episodes: [] };

    const restored = await restoreFoundationState('ser-1', checkpoint);

    expect(restored).toMatchObject({ restored: true, episodesRestored: 1 });
    expect(seriesState).toMatchObject({
      styleNotes: 'voice before',
      styleGuide: { tone: ['spare'] },
      characterArcs: [{ characterName: 'Example Lead' }],
    });
    expect(universeState).toMatchObject({
      premise: 'rules before',
      characters: [{ id: 'chr-1', name: 'Example Lead', need: 'trust' }],
    });
    expect(arcState).toEqual(checkpoint.arcState);
  });
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
  it('isValidFoundationShape requires every concrete rubric finding and rejects the echoed schema example', () => {
    expect(isValidFoundationShape({ dimensions: dims(), oneLineVerdict: 'Specific weakest-link verdict' })).toBe(true);
    expect(isValidFoundationShape({ dimensions: {} })).toBe(false);
    expect(isValidFoundationShape({
      dimensions: Object.fromEntries(FOUNDATION_DIMENSIONS.map((key) => [
        key,
        { score: 6, gap: 'string', fix: 'string' },
      ])),
      oneLineVerdict: 'string',
    })).toBe(false);
    expect(isValidFoundationShape({
      dimensions: { ...dims(), craft: { score: 6, gap: '', fix: 'Add an actionable example.' } },
    })).toBe(false);
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
  it('changes when a core character visual foundation changes', () => {
    const series = { premise: 'Lead crosses the flooded city.' };
    const base = { characters: [{ id: 'c1', name: 'Lead', physicalDescription: '', visualIdentity: '' }] };
    const designed = {
      characters: [{
        ...base.characters[0],
        physicalDescription: 'A compact young surveyor with copper curls and a patched yellow pressure coat.',
        visualIdentity: 'round survey instruments against a narrow triangular silhouette',
        visualNotes: 'mustard and oxidized copper fieldwear',
        silhouetteNotes: 'compact torso, wide tool belt, tapered boots',
        colorPalette: [{ name: 'survey yellow', hex: '#d9a21b', role: 'coat' }],
      }],
    };
    expect(foundationInputsHash(series, base)).not.toBe(foundationInputsHash(series, designed));
  });
  it('changes when a series-linked character profile field changes', () => {
    const series = { id: 'ser-1', premise: 'Lead crosses the flooded city.' };
    const base = { characters: [{ id: 'c1', name: 'Support', sourceSeriesId: 'ser-1', pronouns: '' }] };
    const designed = { characters: [{ ...base.characters[0], pronouns: 'they/them', skills: 'pressure-system maintenance' }] };
    expect(foundationInputsHash(series, base)).not.toBe(foundationInputsHash(series, designed));
  });
  it('changes when the protected author intent changes', () => {
    const base = { starterPrompt: 'A clockmaker discovers that dragons control the weather.' };
    const drifted = { starterPrompt: 'Train conductors regulate an intercity signal network.' };
    expect(foundationInputsHash({}, base)).not.toBe(foundationInputsHash({}, drifted));
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
    expect(foundationInputsHash(series, null, [{ ...issue, arcRole: 'midpoint' }])).not.toBe(base);
    expect(foundationInputsHash(series, null, [{ ...issue, lengthProfile: 'extended' }])).not.toBe(base);
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

  it('keeps every character explicitly minted by this series even before the synopsis names them', () => {
    const characters = [
      { id: 'lead', name: 'Lead' },
      { id: 'support', name: 'Support', sourceSeriesId: 'ser-1' },
      { id: 'other', name: 'Other', sourceSeriesId: 'ser-2' },
    ];
    const series = { id: 'ser-1', characterArcs: [{ characterId: 'lead' }] };
    const ids = seriesFoundationCharacters(characters, series).map((character) => character.id);

    expect(ids).toEqual(expect.arrayContaining(['lead', 'support']));
    expect(ids).not.toContain('other');
  });

  it('uses a six-character fallback only before story references exist', () => {
    const characters = Array.from({ length: 9 }, (_, index) => ({
      id: `chr-${index + 1}`,
      name: `Cast ${index + 1}`,
    }));
    expect(seriesFoundationCharacters(characters, {})).toHaveLength(6);
  });
});

describe('countFoundationCharacterBlanks — objective repair evidence', () => {
  const series = { characterArcs: [{ characterId: 'chr-lead', characterName: 'Lead' }] };
  const blankLead = { id: 'chr-lead', name: 'Lead', role: 'protagonist' };
  const authoredLead = {
    ...blankLead,
    ghost: 'g', wound: 'w', lie: 'l', want: 'wa', need: 'n', coreTheme: 'c', motivations: 'm', speechPattern: 's',
    pronouns: 'they/them', age: 'thirty', speechAccent: 'low measured register',
    personality: 'careful', background: 'trained on the docks', likes: 'tea', dislikes: 'waste',
    mannerisms: 'counts breaths', relationships: 'protective of the crew', skills: 'pressure repair',
    secrets: ['one'],
    physicalDescription: 'p', visualNotes: 'v', silhouetteNotes: 'si', visualIdentity: 'vi',
    colorPalette: [{ name: 'Rope Tan', hex: '#B89A6A' }],
  };

  it('drops to zero once every framework, profile, and visual field is authored', () => {
    expect(countFoundationCharacterBlanks([blankLead], series)).toBe(24);
    expect(countFoundationCharacterBlanks([authoredLead], series)).toBe(0);
  });

  it('counts only the repairable roster — locked and unreferenced cast are excluded', () => {
    const cast = [
      blankLead,
      { id: 'chr-locked', name: 'Locked', locked: true },
      { id: 'chr-extra', name: 'Extra' },
    ];
    const lockedSeries = {
      characterArcs: [
        { characterId: 'chr-lead', characterName: 'Lead' },
        { characterId: 'chr-locked', characterName: 'Locked' },
      ],
    };
    // Only the unlocked, story-referenced lead contributes its 24 blanks.
    expect(countFoundationCharacterBlanks(cast, lockedSeries)).toBe(24);
  });

  it('treats a missing cast as nothing to measure rather than throwing', () => {
    expect(countFoundationCharacterBlanks(null, series)).toBe(0);
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
    expect(out).toContain('#1 Ep 1 [role=unset, length=unset, 1 synopsis words]:');
    expect(out).toContain('#40 Ep 40 [role=unset, length=unset, 1 synopsis words]:');
    expect(out).not.toContain('omitted to fit the prompt budget');
  });

  it('renders authored episode metadata and exact synopsis word counts', () => {
    const issues = [
      {
        number: 1,
        seasonId: 'sea-1',
        title: 'Opening',
        arcRole: 'pilot',
        lengthProfile: 'teaser',
        stages: { idea: { input: 'Three deliberate words' } },
      },
      {
        number: 2,
        seasonId: 'sea-1',
        title: 'Finale',
        arcRole: 'finale',
        lengthProfile: 'custom',
        stages: { idea: { input: '' } },
      },
    ];

    const out = __testing.renderArc(bigSeries, issues);
    expect(out).toContain('#1 Opening [role=pilot, length=teaser, 3 synopsis words]: Three deliberate words');
    expect(out).toContain('#2 Finale [role=finale, length=custom, 0 synopsis words]: (no synopsis)');
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
    expect(out).toContain('#1 Ep 1 [');
    expect(out).not.toContain('#40 Ep 40 [');
    expect(out).toMatch(/\[\d+ later episode synopsis lines omitted to fit the prompt budget\]/);
    for (const line of out.split('\n')) {
      if (line.startsWith('    #')) expect(line.endsWith('x'.repeat(20))).toBe(true);
    }
  });

  it('drops volume synopses, keeping the loglines, when the spine alone overruns the budget', () => {
    // 30 volumes of long synopses: the spine overruns on its own, so tier 2 fires.
    const wideSeries = {
      ...bigSeries,
      seasons: Array.from({ length: 30 }, (_, i) => ({
        id: `sea-${i + 1}`, number: i + 1, title: `V${i + 1}`, logline: 'VL',
        synopsis: 'z'.repeat(300), endingHook: 'EH',
      })),
    };
    const out = __testing.renderArc(wideSeries, manyIssues, { maxChars: 4_000 });
    expect(out.length).toBeLessThanOrEqual(4_000);
    expect(out).toContain('Logline: AL');
    expect(out).toContain('  V1 V1: VL');
    expect(out).not.toContain('    Synopsis: ');
    expect(out).not.toContain('#1 Ep 1 [');
    expect(out).toContain('[60 volume synopsis lines omitted to fit the prompt budget]');
  });

  it('never exceeds the budget even when the volume loglines alone do not fit', () => {
    const out = __testing.renderArc(bigSeries, manyIssues, { maxChars: 120 });
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toContain('Logline: AL');
    expect(out).toContain('[series plan truncated to fit the prompt budget]');
  });

  it('keeps the singular form when exactly one episode is dropped', () => {
    const oneOver = __testing.renderArc(bigSeries, manyIssues.slice(0, 2), { maxChars: 800 });
    expect(oneOver).toContain('[1 later episode synopsis line omitted to fit the prompt budget]');
  });

  // Property test: the budget is a hard contract, so sweep the shape of the
  // series (volume count × episode count × arc count) against a sweep of budgets
  // rather than asserting a handful of hand-picked cases. Budgets deliberately
  // include values below the length of the fixed arc header and below the
  // truncation marker itself, which are the inputs the tiered degradation cannot
  // satisfy by dropping lines.
  it('never returns more than maxChars for any volume/episode/arc shape', () => {
    const budgets = [0, 1, 20, 47, 60, 120, 400, 1_000, 4_000, 12_000];
    for (const volumeCount of [0, 1, 3, 12, 40]) {
      for (const episodesPerVolume of [0, 1, 5, 20]) {
        for (const arcCount of [0, 2, 25]) {
          const seasons = Array.from({ length: volumeCount }, (_, i) => ({
            id: `sea-${i + 1}`, number: i + 1, title: `Volume ${i + 1}`,
            logline: 'l'.repeat(80), synopsis: 's'.repeat(250), endingHook: 'h'.repeat(60),
          }));
          const series = {
            arc: { logline: 'a'.repeat(90), summary: 'b'.repeat(200), themes: ['t1', 't2'], protagonistArc: 'p'.repeat(80), shape: 'rise' },
            seasons,
            characterArcs: Array.from({ length: arcCount }, (_, i) => ({
              characterId: `chr-${i}`, characterName: `Cast ${i}`,
              startState: 'x'.repeat(40), endState: 'y'.repeat(40), want: 'w'.repeat(40), need: 'n'.repeat(40),
            })),
          };
          const issues = seasons.flatMap((season, s) => Array.from({ length: episodesPerVolume }, (_, e) => ({
            number: s * episodesPerVolume + e + 1,
            seasonId: season.id,
            title: `Ep ${e + 1}`,
            stages: { idea: { input: 'e'.repeat(300) } },
          })));
          for (const maxChars of budgets) {
            const out = __testing.renderArc(series, issues, { maxChars });
            expect(
              out.length,
              `volumes=${volumeCount} episodes=${episodesPerVolume} arcs=${arcCount} maxChars=${maxChars}`,
            ).toBeLessThanOrEqual(maxChars);
          }
          // Unbudgeted renders stay complete — the tiers must not leak into the default.
          const full = __testing.renderArc(series, issues);
          expect(full).not.toContain('to fit the prompt budget');
        }
      }
    }
  });
});

describe('foundation repair prompt — bounded series seed and cast', () => {
  const bigSeries = () => ({
    id: 'ser-1',
    name: 'Example Series',
    premise: 'p'.repeat(2_000),
    targetFormat: 'novella',
    issueCountTarget: 24,
    styleNotes: 'n'.repeat(1_500),
    styleGuide: {
      voiceExemplars: Array.from({ length: 6 }, (_, i) => ({ passage: 'g'.repeat(1_200), note: `note ${i}` })),
      voiceAntiExemplars: Array.from({ length: 6 }, (_, i) => ({ passage: 'x'.repeat(1_200), note: `anti ${i}` })),
    },
    characterArcs: Array.from({ length: 18 }, (_, i) => ({
      characterId: `chr-${i}`, characterName: `Cast ${i}`,
      want: 'w'.repeat(60), need: 'n'.repeat(60),
      startState: 's'.repeat(400), endState: 'e'.repeat(400),
      transitions: Array.from({ length: 6 }, (_, t) => ({ kind: 'decision', atIssue: t, label: 'l'.repeat(120) })),
    })),
  });

  it('drops style-guide exemplars first, then character-arc detail, to fit the series budget', () => {
    const rendered = __testing.renderRepairSeriesJson(bigSeries());
    expect(rendered.length).toBeLessThanOrEqual(__testing.REPAIR_SERIES_MAX_CHARS);
    expect(() => JSON.parse(rendered)).not.toThrow();
    const parsed = JSON.parse(rendered);
    // The brief itself is unconditional.
    expect(parsed.premise).toBe('p'.repeat(2_000));
    expect(parsed.styleNotes).toBe('n'.repeat(1_500));
    expect(parsed.targetFormat).toBe('novella');
    expect(parsed.issueCountTarget).toBe(24);
    expect(parsed.styleGuide).toBeUndefined();
    // Arcs survive as the want/need spine; the transition beats do not.
    expect(parsed.characterArcs).toHaveLength(18);
    expect(parsed.characterArcs[0].transitions).toBeUndefined();
    expect(parsed.omitted).toMatch(/omitted to fit the prompt budget/);
  });

  it('leaves a small series seed byte-identical to the unbudgeted render', () => {
    const small = { id: 'ser-1', name: 'S', premise: 'P', targetFormat: 'novella', issueCountTarget: 6, styleNotes: 'SN', styleGuide: { voiceExemplars: [] }, characterArcs: [] };
    const parsed = JSON.parse(__testing.renderRepairSeriesJson(small));
    expect(parsed.styleGuide).toEqual({ voiceExemplars: [] });
    expect(parsed.omitted).toBeUndefined();
  });

  it('trims free-text fields as a floor when the brief alone overruns, keeping valid JSON', () => {
    const rendered = __testing.renderRepairSeriesJson({ id: 'ser-1', name: 'S', premise: 'p'.repeat(5_000), styleNotes: 'n'.repeat(5_000) }, 2_000);
    expect(rendered.length).toBeLessThanOrEqual(2_000);
    expect(() => JSON.parse(rendered)).not.toThrow();
    expect(rendered).toContain('truncated to fit the prompt budget');
  });

  const castMember = (i, size) => ({
    id: `chr-${i}`, name: `Cast ${i}`, role: 'lead',
    personality: 'q'.repeat(size), background: 'b'.repeat(size), relationships: 'r'.repeat(size),
    want: 'w'.repeat(60), need: 'n'.repeat(60), ghost: 'g'.repeat(size), wound: 'o'.repeat(size),
  });

  it('caps the candidate cast by size, compacting the full roster before dropping members', () => {
    const payload = {
      targetCharacters: Array.from({ length: 6 }, (_, i) => castMember(i, 200)),
      fullSeriesRoster: Array.from({ length: 40 }, (_, i) => castMember(i, 200)),
    };
    const rendered = __testing.renderRepairCharactersJson(payload);
    expect(rendered.length).toBeLessThanOrEqual(__testing.REPAIR_CHARACTERS_MAX_CHARS);
    const parsed = JSON.parse(rendered);
    // The batch under repair keeps every field intact — it outranks the roster.
    expect(parsed.targetCharacters).toHaveLength(6);
    expect(parsed.targetCharacters[0].background).toBe('b'.repeat(200));
    // The roster degrades to the differentiation spine.
    expect(parsed.fullSeriesRoster.length).toBeGreaterThan(0);
    expect(parsed.fullSeriesRoster[0]).toEqual({
      id: 'chr-0',
      name: 'Cast 0',
      role: 'lead',
      want: 'w'.repeat(60),
      need: 'n'.repeat(60),
      physicalDescription: '',
      visualIdentity: '',
    });
    expect(parsed.rosterNote).toMatch(/fit the prompt budget/);
  });

  it('truncates the batch\'s own fields when six full characters alone overrun the budget', () => {
    const payload = {
      targetCharacters: Array.from({ length: 6 }, (_, i) => castMember(i, 1_500)),
      fullSeriesRoster: Array.from({ length: 40 }, (_, i) => castMember(i, 1_500)),
    };
    const rendered = __testing.renderRepairCharactersJson(payload);
    expect(rendered.length).toBeLessThanOrEqual(__testing.REPAIR_CHARACTERS_MAX_CHARS);
    const parsed = JSON.parse(rendered);
    expect(parsed.targetCharacters).toHaveLength(6);
    expect(parsed.targetCharacters[0].background).toContain('truncated to fit the prompt budget');
    expect(parsed.targetNote).toMatch(/truncated to fit the prompt budget/);
  });

  it('leaves an already-small cast payload untouched', () => {
    const payload = { targetCharacters: [{ id: 'chr-1', name: 'A' }], fullSeriesRoster: [{ id: 'chr-1', name: 'A' }] };
    expect(JSON.parse(__testing.renderRepairCharactersJson(payload))).toEqual(payload);
  });

  // The tiered degradation has to bottom out at a hard bound, not merely get
  // closer to one — sweep cast size × field size × budget, including budgets far
  // below one character's worth of prose.
  it('never exceeds the character budget for any cast size or field size', () => {
    for (const castSize of [0, 1, 6, 40, 120]) {
      for (const fieldSize of [10, 200, 1_500, 6_000]) {
        const members = Array.from({ length: castSize }, (_, i) => ({
          ...castMember(i, fieldSize),
          secrets: ['s'.repeat(fieldSize)],
          // A nested object-in-array shape must not smuggle prose past the cap.
          transitions: [{ kind: 'decision', label: 'l'.repeat(fieldSize) }],
        }));
        for (const maxChars of [2_000, 12_000]) {
          const object = __testing.renderRepairCharactersJson(
            { targetCharacters: members.slice(0, 6), fullSeriesRoster: members },
            maxChars,
          );
          const array = __testing.renderRepairCharactersJson(members, maxChars);
          const label = `cast=${castSize} field=${fieldSize} maxChars=${maxChars}`;
          expect(object.length, `object ${label}`).toBeLessThanOrEqual(maxChars);
          expect(array.length, `array ${label}`).toBeLessThanOrEqual(maxChars);
          expect(() => JSON.parse(object), `object ${label}`).not.toThrow();
          expect(() => JSON.parse(array), `array ${label}`).not.toThrow();
        }
      }
    }
  });

  it('never exceeds the series budget for any arc count or free-text size', () => {
    for (const arcCount of [0, 1, 18, 200]) {
      for (const textSize of [10, 2_000, 20_000]) {
        const series = {
          id: 'ser-1', name: 'Example Series', targetFormat: 'novella', issueCountTarget: 24,
          premise: 'p'.repeat(textSize), styleNotes: 'n'.repeat(textSize),
          styleGuide: { voiceExemplars: [{ passage: 'g'.repeat(textSize), note: 'note' }] },
          characterArcs: Array.from({ length: arcCount }, (_, i) => ({
            characterId: `chr-${i}`, characterName: `Cast ${i}`,
            want: 'w'.repeat(textSize), need: 'n'.repeat(textSize),
            transitions: [{ kind: 'decision', label: 'l'.repeat(textSize) }],
          })),
        };
        for (const maxChars of [2_000, 12_000]) {
          const rendered = __testing.renderRepairSeriesJson(series, maxChars);
          const label = `arcs=${arcCount} text=${textSize} maxChars=${maxChars}`;
          expect(rendered.length, label).toBeLessThanOrEqual(maxChars);
          expect(() => JSON.parse(rendered), label).not.toThrow();
        }
      }
    }
  });

  // Unlike `renderArc` (plain text, hard-clamped), the JSON sections cannot slice
  // their way under an arbitrarily small budget without handing the model a parse
  // error. Below the structural floor they emit the smallest VALID payload they
  // can and overshoot — pinned here so the asymmetry is a decision, not a
  // surprise. The real budgets are 12,000, orders of magnitude above the floor.
  it('emits valid JSON rather than a corrupt slice when the budget is below the structural floor', () => {
    const cast = __testing.renderRepairCharactersJson({ targetCharacters: [], fullSeriesRoster: [] }, 40);
    const series = __testing.renderRepairSeriesJson({ id: 'ser-1', name: 'S', premise: 'p'.repeat(9_000) }, 40);
    expect(() => JSON.parse(cast)).not.toThrow();
    expect(() => JSON.parse(series)).not.toThrow();
    // The floor is the JSON skeleton itself (keys + the notes naming what was cut).
    expect(cast.length).toBeLessThan(500);
    expect(series.length).toBeLessThan(500);
  });

  it('caps the flat (non-character-dimension) cast array by size too', () => {
    const array = Array.from({ length: 60 }, (_, i) => ({ id: `chr-${i}`, name: `Cast ${i}`, background: 'b'.repeat(900) }));
    const rendered = __testing.renderRepairCharactersJson(array);
    expect(rendered.length).toBeLessThanOrEqual(__testing.REPAIR_CHARACTERS_MAX_CHARS);
    expect(Array.isArray(JSON.parse(rendered))).toBe(true);
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
    expect(vars.outline.length).toBeLessThanOrEqual(__testing.REPAIR_OUTLINE_MAX_CHARS);
    expect(vars.outline).toContain('omitted to fit the prompt budget');
    expect(vars.outline).toContain('  V1 V1: VL');
  });

  // Regression for the 72,404-char character-foundation prompt that burned a CLI
  // runner's full 5-minute wall clock without emitting a byte (#3726).
  describe('character foundation — whole-prompt budget', () => {
    const seasons = Array.from({ length: 8 }, (_, i) => ({
      id: `sea-${i + 1}`, number: i + 1, title: `Volume ${i + 1}`,
      logline: 'l'.repeat(120), synopsis: 's'.repeat(900), endingHook: 'h'.repeat(200),
    }));
    const cast = Array.from({ length: 18 }, (_, i) => ({
      id: `chr-${i}`, name: `Cast ${i}`, role: 'lead',
      personality: 'q'.repeat(700), background: 'b'.repeat(700), relationships: 'r'.repeat(700),
      want: 'w'.repeat(150), need: 'n'.repeat(150), ghost: 'g'.repeat(500), wound: 'o'.repeat(500),
      lie: 'x'.repeat(300), coreTheme: 'c'.repeat(200), motivations: 'm'.repeat(400),
      speechPattern: 'p'.repeat(200), arcType: 'positive', secrets: ['z'.repeat(300)],
    }));

    beforeEach(() => {
      const series = {
        id: 'ser-1', name: 'Example Series', universeId: 'uni-1',
        premise: 'p'.repeat(2_500), targetFormat: 'novella', issueCountTarget: 40,
        styleNotes: 'n'.repeat(1_800),
        seasons,
        styleGuide: {
          voiceExemplars: Array.from({ length: 6 }, () => ({ passage: 'g'.repeat(1_200), note: 'note' })),
          voiceAntiExemplars: Array.from({ length: 6 }, () => ({ passage: 'x'.repeat(1_200), note: 'anti' })),
        },
        characterArcs: cast.map((character) => ({
          characterId: character.id, characterName: character.name,
          want: character.want, need: character.need,
          startState: 'a'.repeat(400), endState: 'e'.repeat(400),
          transitions: Array.from({ length: 6 }, (_, t) => ({ kind: 'decision', atIssue: t + 1, label: 'l'.repeat(150) })),
        })),
      };
      const universe = { id: 'uni-1', characters: cast };
      seriesSvc.getSeries.mockResolvedValue(series);
      universeBuilder.getUniverse.mockResolvedValue(universe);
      universeBuilder.updateUniverse.mockImplementation(async (id, mutator) => ({ id, ...(mutator(universe) || {}) }));
      issuesSvc.listIssues.mockResolvedValue(seasons.flatMap((season, s) => Array.from({ length: 10 }, (_, e) => ({
        number: s * 10 + e + 1, seasonId: season.id, title: `Ep ${e + 1}`,
        stages: { idea: { input: 'y'.repeat(600) } },
      }))));
      stageRunner.runStagedLLM.mockResolvedValue({ content: { characters: [], characterArcs: [] } });
    });

    it('keeps every stage prompt under 45,000 chars for 8 volumes / 18 characters / a full style guide', async () => {
      await applyFoundationFix('ser-1', 'character', { finding: { gap: 'blank lead', fix: 'build the causal chain' } });

      const calls = stageRunner.runStagedLLM.mock.calls.filter(([name]) => name === 'pipeline-character-foundation');
      expect(calls.length).toBeGreaterThan(0);
      for (const [, vars] of calls) {
        const total = Object.values(vars).reduce((sum, value) => sum + String(value ?? '').length, 0);
        expect(total).toBeLessThan(45_000);
        expect(vars.seriesJson.length).toBeLessThanOrEqual(__testing.REPAIR_SERIES_MAX_CHARS);
        expect(vars.charactersJson.length).toBeLessThanOrEqual(__testing.REPAIR_CHARACTERS_MAX_CHARS);
        expect(vars.outline.length).toBeLessThanOrEqual(__testing.REPAIR_OUTLINE_MAX_CHARS);
      }
    });

    it('requests a twelve-hour timeout so productive high-effort ensemble work is not killed early', async () => {
      await applyFoundationFix('ser-1', 'character', { finding: { gap: 'blank lead', fix: 'build the causal chain' } });

      expect(__testing.CHARACTER_FOUNDATION_TIMEOUT_MS).toBe(43_200_000);
      expect(stageRunner.runStagedLLM).toHaveBeenCalledWith(
        'pipeline-character-foundation',
        expect.anything(),
        expect.objectContaining({ timeoutOverride: 43_200_000 }),
      );
    });
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

  it('shows actual visual identity details instead of presence-only ready markers', () => {
    const ctx = __testing.buildFoundationContext({
      series: { name: 'Example Series', characterArcs: [{ characterId: 'chr-1' }], seasons: [] },
      universe: {},
      canon: { characters: [{
        id: 'chr-1',
        name: 'Lead',
        physicalDescription: 'A compact young surveyor with copper curls and a patched yellow pressure coat.',
        visualNotes: 'Every tool is repaired with visible blue ceramic staples.',
        silhouetteNotes: 'Compact torso, wide tool belt, tapered boots.',
        visualIdentity: 'Round survey instruments interrupt a narrow triangular silhouette.',
        colorPalette: [{ name: 'survey yellow', hex: '#d9a21b', role: 'coat' }],
      }] },
      issues: [],
      contentMax: 30_000,
    });

    expect(ctx.characterRoster).toContain('patched yellow pressure coat');
    expect(ctx.characterRoster).toContain('Round survey instruments');
    expect(ctx.characterRoster).toContain('survey yellow');
    expect(ctx.characterRoster).not.toContain('physicalDescription: ready');
  });

  it('shows profile blanks for a series-linked supporting character', () => {
    const ctx = __testing.buildFoundationContext({
      series: { id: 'ser-1', name: 'Example Series', seasons: [] },
      universe: {},
      canon: { characters: [{
        id: 'chr-support', name: 'Support', sourceSeriesId: 'ser-1',
        personality: 'Methodical under pressure', pronouns: '', age: '', skills: '',
      }] },
      issues: [],
      contentMax: 30_000,
    });
    expect(ctx.characterRoster).toContain('personality: Methodical under pressure');
    expect(ctx.characterRoster).toContain('pronouns: —');
    expect(ctx.characterRoster).toContain('skills: —');
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

describe('renderWorldFoundation — budget spends the noun inventory, not the rules', () => {
  const rulesTail = 'RESONANCE RULESET: range 40m, cost one week of hearing, fails in wet air, cannot cross bone.';
  const worldWithRules = (entityCount) => ({
    logline: 'A colony sings its machines awake.',
    premise: `${'Established lore paragraph. '.repeat(200)}${rulesTail}`,
    styleNotes: 'Humid, tactile, close third person.',
    places: Array.from({ length: entityCount }, (_, index) => ({
      id: `plc-${index}`,
      name: `Place ${index}`,
      description: `A named location the judge already has plenty of. ${'detail '.repeat(20)}`,
    })),
  });

  it('keeps the premise tail — where a freshly authored ruleset lands — and drops canon nouns instead', () => {
    const world = worldWithRules(60);
    const unbounded = __testing.renderWorldFoundation(world);
    expect(unbounded).toContain('Named canon:');
    expect(unbounded).toContain(rulesTail);

    const budgeted = __testing.renderWorldFoundation(world, { maxChars: 6_500 });
    expect(budgeted.length).toBeLessThanOrEqual(6_500 + 60);
    // The repair the judge asked for survives the budget…
    expect(budgeted).toContain(rulesTail);
    // …and the entity inventory is what paid for it.
    expect(budgeted).not.toContain('Place 59');
  });

  it('renders the protected author intent ahead of the derived world bible', () => {
    const out = __testing.renderWorldFoundation({
      starterPrompt: 'A baker discovers that the moon is a sleeping whale.',
      premise: 'The current generated premise.',
    });
    expect(out).toContain('Protected author intent (starter idea): A baker discovers that the moon is a sleeping whale.');
    expect(out.indexOf('Protected author intent')).toBeLessThan(out.indexOf('Universe premise'));
  });

  it('omits the canon line outright rather than rendering a useless stub', () => {
    const out = __testing.renderWorldFoundation(worldWithRules(60), { maxChars: 5_900 });
    expect(out).toContain('Named canon: [omitted to fit the judging budget]');
    expect(out).toContain(rulesTail);
  });

  it('still marks a truncation when the narrative spine alone overruns the budget', () => {
    const out = __testing.renderWorldFoundation(worldWithRules(2), { maxChars: 1_000 });
    expect(out.length).toBeLessThanOrEqual(1_000 + 40);
    expect(out).toContain('[world summary truncated for judging]');
  });

  it('reports a missing universe unchanged', () => {
    expect(__testing.renderWorldFoundation(null, { maxChars: 10 }))
      .toBe('(no linked universe — worldbuilding cannot be judged from canon)');
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

  it('re-judges a matching cached snapshot whose findings are echoed schema placeholders', async () => {
    const series = { id: 'ser-1', name: 'S', universeId: null };
    seriesSvc.getSeries.mockResolvedValue(series);
    const hash = foundationInputsHash(series, null);
    const placeholderDimensions = Object.fromEntries(FOUNDATION_DIMENSIONS.map((key) => [
      key,
      { score: 6, gap: 'string', fix: 'string' },
    ]));
    fileUtils.tryReadFile.mockResolvedValue(JSON.stringify({
      seriesId: 'ser-1',
      status: 'complete',
      sourceInputsHash: hash,
      weightedScore: 6,
      dimensions: placeholderDimensions,
      oneLineVerdict: 'string',
    }));
    stageRunner.runStagedLLM.mockResolvedValue({
      content: { dimensions: dims({ worldbuilding: 7 }), oneLineVerdict: 'Fresh specific verdict.' },
      providerId: 'judge-x', model: 'jm-heavy', runId: 'run-rejudge',
    });

    const out = await judgeFoundation('ser-1');

    expect(stageRunner.runStagedLLM).toHaveBeenCalledTimes(1);
    expect(out.cached).toBeUndefined();
    expect(out.runId).toBe('run-rejudge');
    expect(out.oneLineVerdict).toBe('Fresh specific verdict.');
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

  it('retries an echoed output-contract placeholder instead of persisting it as a score-six verdict', async () => {
    seriesSvc.getSeries.mockResolvedValue({ id: 'ser-1', name: 'S', universeId: null });
    const placeholderDimensions = Object.fromEntries(FOUNDATION_DIMENSIONS.map((key) => [
      key,
      { score: 6, gap: 'string', fix: 'string' },
    ]));
    stageRunner.runStagedLLM
      .mockResolvedValueOnce({
        content: { dimensions: placeholderDimensions, oneLineVerdict: 'string' },
        providerId: 'judge-x', model: 'jm-heavy', runId: 'run-placeholder',
      })
      .mockResolvedValueOnce({
        content: { dimensions: dims({ worldbuilding: 7 }), oneLineVerdict: 'The world rule is the weakest link.' },
        providerId: 'judge-x', model: 'jm-heavy', runId: 'run-real',
      });

    const out = await judgeFoundation('ser-1', { force: true });

    expect(stageRunner.runStagedLLM).toHaveBeenCalledTimes(2);
    expect(out.runId).toBe('run-real');
    expect(out.dimensions.worldbuilding.gap).toBe('gap worldbuilding');
    expect(out.oneLineVerdict).toBe('The world rule is the weakest link.');
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
    expect(arcPlanner.snapshotArcState).toHaveBeenCalledWith('ser-1');
    expect(arcPlanner.verifyArc).toHaveBeenCalledWith('ser-1', expect.any(Object));
    expect(r).toMatchObject({ dimension: 'structure', applied: true, actions: 2 });
  });

  it('gives a structure repair one bounded arc-verifier correction pass', async () => {
    const blocker = {
      severity: 'high', location: 'Issue 6', problem: 'The crossing skips its destination consent.',
      suggestion: 'Require the far operator to authorize the opening.',
    };
    arcPlanner.verifyArc
      .mockResolvedValueOnce({ issues: [blocker] })
      .mockResolvedValueOnce({ issues: [] });

    const writerOnRunCreated = vi.fn();
    const judgeOnRunCreated = vi.fn();
    const r = await applyFoundationFix('ser-1', 'structure', {
      finding: { gap: 'The midpoint lacks a costly reversal.', fix: 'Add a costly reversal.' },
      providerOverride: 'writer-provider',
      modelOverride: 'writer-model',
      effortOverride: 'max',
      onRunCreated: writerOnRunCreated,
      judgeProviderDefault: 'judge-provider',
      judgeModelDefault: 'judge-model',
      judgeEffortDefault: 'xhigh',
      judgeOnRunCreated,
    });

    expect(arcPlanner.resolveVerifyIssues).toHaveBeenCalledTimes(2);
    expect(arcPlanner.resolveVerifyIssues).toHaveBeenNthCalledWith(2, 'ser-1', expect.objectContaining({
      findings: [blocker], providerDefault: 'writer-provider', modelDefault: 'writer-model', effortDefault: 'max',
      onRunCreated: expect.any(Function),
    }));
    expect(arcPlanner.verifyArc).toHaveBeenNthCalledWith(1, 'ser-1', expect.objectContaining({
      providerDefault: 'judge-provider', modelDefault: 'judge-model', effortDefault: 'xhigh',
      onRunCreated: judgeOnRunCreated,
    }));
    expect(arcPlanner.restoreArcState).not.toHaveBeenCalled();
    expect(r).toMatchObject({ dimension: 'structure', applied: true, actions: 4 });
  });

  it('keeps correcting a structure repair while its blocker count shrinks', async () => {
    const many = Array.from({ length: 10 }, (_, idx) => ({
      severity: 'medium', location: `Issue ${idx + 1}`, problem: `Blocker ${idx + 1}`,
    }));
    const three = many.slice(0, 3);
    arcPlanner.verifyArc
      .mockResolvedValueOnce({ issues: many })
      .mockResolvedValueOnce({ issues: three })
      .mockResolvedValueOnce({ issues: [] });

    const r = await applyFoundationFix('ser-1', 'structure', {
      finding: { gap: 'The issue plan contradicts the series spine.', fix: 'Reconcile it.' },
    });

    expect(arcPlanner.resolveVerifyIssues).toHaveBeenCalledTimes(3);
    expect(arcPlanner.verifyArc).toHaveBeenCalledTimes(3);
    expect(arcPlanner.restoreArcState).not.toHaveBeenCalled();
    expect(r).toMatchObject({ dimension: 'structure', applied: true, actions: 6 });
  });

  it('retains the best verified structure checkpoint when a later correction regresses', async () => {
    const original = { seriesId: 'ser-1', arc: { logline: 'Original' }, seasons: [], episodes: [] };
    const firstCandidate = { seriesId: 'ser-1', arc: { logline: 'Nine blockers' }, seasons: [], episodes: [] };
    const bestCandidate = { seriesId: 'ser-1', arc: { logline: 'One blocker' }, seasons: [], episodes: [] };
    arcPlanner.snapshotArcState
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(firstCandidate)
      .mockResolvedValueOnce(bestCandidate);
    const findings = (n, prefix) => Array.from({ length: n }, (_, i) => ({
      severity: 'medium', location: `Issue ${i + 1}`, problem: `${prefix} ${i + 1}`,
    }));
    arcPlanner.verifyArc
      .mockResolvedValueOnce({ issues: findings(9, 'initial') })
      .mockResolvedValueOnce({ issues: findings(1, 'best') })
      .mockResolvedValueOnce({ issues: findings(5, 'regressed') });
    const wrote = (issueId) => ({ issueId, idea: { input: `${issueId} synopsis`, output: '', status: 'empty' } });
    arcPlanner.resolveVerifyIssues
      .mockImplementationOnce(async (_id, options) => {
        options.onRunCreated('structure-broad');
        return { applied: true, episodesResolved: [wrote('iss-broad')] };
      })
      .mockImplementationOnce(async (_id, options) => {
        options.onRunCreated('structure-improved');
        return { applied: true, episodesResolved: [wrote('iss-improved')] };
      })
      .mockImplementationOnce(async (_id, options) => {
        options.onRunCreated('structure-regressed');
        return { applied: true, episodesResolved: [wrote('iss-regressed')] };
      });

    const r = await applyFoundationFix('ser-1', 'structure', {
      finding: { gap: 'The issue plan contradicts the spine.', fix: 'Reconcile it.' },
      onRunCreated: vi.fn(),
    });

    // The rewind to the best checkpoint may only undo what landed AFTER it: the
    // regressed pass's episode write. The two retained passes' writes are part
    // of the improvement being kept, and anything else in the store belongs to
    // whoever wrote it (#4135).
    expect(arcPlanner.restoreArcState).toHaveBeenCalledWith('ser-1', bestCandidate, {
      episodeEdits: [wrote('iss-regressed')],
    });
    expect(arcPlanner.restoreArcState).not.toHaveBeenCalledWith('ser-1', original, expect.anything());
    expect(r).toMatchObject({
      dimension: 'structure', applied: true, partial: true,
      acceptedRunIds: ['structure-broad', 'structure-improved'],
      rejectedRunIds: ['structure-regressed'],
    });
    expect(r.residual).toHaveLength(1);
    expect(r.discarded).toHaveLength(5);
  });

  it('prefers more lower-severity residuals over fewer high-severity blockers', async () => {
    const original = { seriesId: 'ser-1', arc: { logline: 'Original' }, seasons: [], episodes: [] };
    const highCheckpoint = { seriesId: 'ser-1', arc: { logline: 'Two high blockers remain' }, seasons: [], episodes: [] };
    const lowerCheckpoint = { seriesId: 'ser-1', arc: { logline: 'Only medium and low residuals' }, seasons: [], episodes: [] };
    arcPlanner.snapshotArcState
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(highCheckpoint)
      .mockResolvedValueOnce(lowerCheckpoint);
    const findings = (severities, prefix) => severities.map((severity, i) => ({
      severity, location: `Issue ${i + 1}`, problem: `${prefix} ${i + 1}`,
    }));
    const highResiduals = findings(['high', 'high', 'medium', 'medium'], 'high checkpoint');
    const lowerResiduals = findings(['medium', 'medium', 'medium', 'medium', 'medium', 'low'], 'lower checkpoint');
    const worseResiduals = findings(['medium', 'medium', 'medium', 'medium', 'medium', 'medium', 'low'], 'worse checkpoint');
    arcPlanner.verifyArc
      .mockResolvedValueOnce({ issues: highResiduals })
      .mockResolvedValueOnce({ issues: lowerResiduals })
      .mockResolvedValueOnce({ issues: worseResiduals });
    arcPlanner.resolveVerifyIssues
      .mockImplementationOnce(async (_id, options) => {
        options.onRunCreated('structure-broad');
        return { applied: true };
      })
      .mockImplementationOnce(async (_id, options) => {
        options.onRunCreated('structure-lower-severity');
        return { applied: true };
      })
      .mockImplementationOnce(async (_id, options) => {
        options.onRunCreated('structure-more-mediums');
        return { applied: true };
      });

    const r = await applyFoundationFix('ser-1', 'structure', {
      finding: { gap: 'The issue plan contradicts the spine.', fix: 'Reconcile it.' },
      onRunCreated: vi.fn(),
    });

    expect(arcPlanner.restoreArcState).toHaveBeenCalledWith('ser-1', lowerCheckpoint, { episodeEdits: [] });
    expect(r).toMatchObject({
      dimension: 'structure', applied: true, partial: true,
      acceptedRunIds: ['structure-broad', 'structure-lower-severity'],
      rejectedRunIds: ['structure-more-mediums'],
    });
    expect(r.residual).toEqual(lowerResiduals);
    expect(r.discarded).toEqual(worseResiduals);
    expect(r.reason).toContain('0 high, 5 medium, 1 low');
  });

  it('rolls a structure repair back when its bounded correction remains unverified', async () => {
    const snapshot = { seriesId: 'ser-1', arc: { logline: 'Before' }, seasons: [], episodes: [] };
    // A fresh object per call, as the real `snapshotArcState` returns — the
    // ledger keys checkpoints by identity, so a shared literal would make every
    // later checkpoint alias the pre-repair one.
    arcPlanner.snapshotArcState.mockImplementation(async () => structuredClone(snapshot));
    const wrote = (issueId) => ({ issueId, idea: { input: `${issueId} synopsis`, output: '', status: 'empty' } });
    arcPlanner.resolveVerifyIssues.mockImplementation(async () => ({
      applied: true,
      episodesResolved: [wrote(`iss-${arcPlanner.resolveVerifyIssues.mock.calls.length}`)],
    }));
    arcPlanner.verifyArc
      .mockResolvedValueOnce({ issues: [{ severity: 'high', location: 'Issue 6', problem: 'First blocker' }] })
      .mockResolvedValueOnce({ issues: [{ severity: 'high', location: 'Issue 7', problem: 'Residual blocker' }] })
      .mockResolvedValueOnce({ issues: [{ severity: 'high', location: 'Issue 8', problem: 'Still blocked' }] })
      .mockResolvedValueOnce({ issues: [{ severity: 'high', location: 'Issue 9', problem: 'Still blocked after cap' }] });

    const r = await applyFoundationFix('ser-1', 'structure', {
      finding: { gap: 'The midpoint lacks a costly reversal.', fix: 'Add a costly reversal.' },
    });

    // The full-revert manifest spans the whole exposure window: the first
    // resolve plus every correction pass, and nothing outside them (#4135).
    expect(arcPlanner.restoreArcState).toHaveBeenCalledWith('ser-1', snapshot, {
      episodeEdits: [wrote('iss-1'), wrote('iss-2'), wrote('iss-3'), wrote('iss-4')],
    });
    expect(r).toMatchObject({ dimension: 'structure', applied: false, actions: 8 });
    expect(r.reason).toMatch(/reverted to the pre-repair plan/);
  });

  it('rolls a mutated structure repair back when verification errors', async () => {
    const snapshot = { seriesId: 'ser-1', arc: { logline: 'Before' }, seasons: [], episodes: [] };
    const wrote = { issueId: 'iss-1', idea: { input: 'resolver rewrote iss-1', output: '', status: 'empty' } };
    arcPlanner.snapshotArcState.mockResolvedValue(snapshot);
    arcPlanner.resolveVerifyIssues.mockResolvedValue({ applied: true, episodesResolved: [wrote] });
    arcPlanner.verifyArc.mockRejectedValueOnce(new Error('judge provider unavailable'));

    await expect(applyFoundationFix('ser-1', 'structure', {
      finding: { gap: 'The midpoint lacks a costly reversal.', fix: 'Add a costly reversal.' },
    })).rejects.toThrow('judge provider unavailable');

    // Even the provider-failure bail-out undoes only the resolve's own writes.
    expect(arcPlanner.restoreArcState).toHaveBeenCalledWith('ser-1', snapshot, { episodeEdits: [wrote] });
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

  it('carries a rejected earlier attempt into the retry so it can change strategy', async () => {
    // The gate reverts a repair whose target did not improve and then retries it
    // (see runFoundationGate). Without the reverted attempt in the payload, the
    // retry re-proposes the same edits and buys a second rollback.
    const retryReason = 'A previous character repair this run was REVERTED: it left the target score at 5.';
    const uni = { id: 'uni-1', characters: [{ id: 'chr-thin', name: 'B' }] };
    universeBuilder.getUniverse.mockResolvedValue(uni);
    universeBuilder.updateUniverse.mockImplementation(async (id, mutator) => ({ id, ...(mutator(uni) || {}) }));
    stageRunner.runStagedLLM.mockResolvedValue({ content: { characters: [] } });

    await applyFoundationFix('ser-1', 'character', { finding: { gap: 'blank lead', fix: 'build the chain', retryReason } });
    expect(JSON.parse(stageRunner.runStagedLLM.mock.calls.at(-1)[1].foundationFindingJson)).toMatchObject({
      gap: 'blank lead', fix: 'build the chain', retryReason,
    });

    stageRunner.runStagedLLM.mockClear();
    await applyFoundationFix('ser-1', 'worldbuilding', { finding: { gap: 'costless magic', fix: 'price it', retryReason } });
    expect(universeBuilderExpand.expandWorldTemplate).toHaveBeenCalledWith(expect.objectContaining({
      foundationDirective: expect.stringContaining(retryReason),
    }));

    // Structure has a structured channel of its own: the reverted findings ride
    // `avoid` (never authored again) instead of the suggestion the resolver
    // would read as work to close.
    const discarded = [{ severity: 'high', location: 'arc', problem: 'the charter handoff is still thin' }];
    await applyFoundationFix('ser-1', 'structure', {
      finding: { gap: 'thin handoff', fix: 'stage it', retryReason },
      avoidFindings: discarded,
    });
    expect(arcPlanner.resolveVerifyIssues).toHaveBeenCalledWith('ser-1', expect.objectContaining({
      findings: [expect.objectContaining({ problem: 'thin handoff', suggestion: 'stage it' })],
      avoid: discarded,
    }));
  });

  it('keeps existing transition beats structure-owned during post-arc character repair', async () => {
    const existingTransition = { kind: 'decision', atIssue: 6, label: 'refuses the unsupported shortcut' };
    const series = {
      id: 'ser-1', name: 'S', premise: 'P', universeId: 'uni-1',
      characterArcs: [{
        characterId: 'chr-1', characterName: 'Example Listener', want: 'Prove the protocol',
        need: 'Accept uncertainty', startState: 'certain', endState: 'careful',
        transitions: [existingTransition], status: 'draft',
      }],
    };
    const universe = { id: 'uni-1', characters: [{ id: 'chr-1', name: 'Example Listener' }] };
    seriesSvc.getSeries.mockResolvedValue(series);
    universeBuilder.getUniverse.mockResolvedValue(universe);
    universeBuilder.updateUniverse.mockImplementation(async (id, mutator) => ({ id, ...(mutator(universe) || {}) }));
    stageRunner.runStagedLLM.mockResolvedValue({ content: {
      characters: [{
        id: 'chr-1', name: 'Example Listener', ghost: 'A failed test', wound: 'Fears ambiguity',
        lie: 'One protocol can prove innocence', want: 'Prove the protocol', need: 'Accept uncertainty',
        coreTheme: 'restraint without innocence', motivations: 'Protect workers and avoid blame',
        speechPattern: 'measured sensory clauses', arcType: 'flat', secrets: ['Cannot hear the upper band'],
      }],
      characterArcs: [{
        characterId: 'chr-1', characterName: 'Example Listener', want: 'Prove the protocol',
        need: 'Accept uncertainty', startState: 'certain', endState: 'still opposed to the lead',
        transitions: [{ kind: 'decision', atIssue: 2, label: 'new unsupported early appearance' }],
        status: 'draft',
      }],
    } });

    await applyFoundationFix('ser-1', 'character', {
      finding: { gap: 'too agreeable', fix: 'retain a principled opponent' },
    });

    const patch = seriesSvc.updateSeries.mock.calls.at(-1)[1];
    expect(patch.characterArcs[0]).toMatchObject({ endState: 'still opposed to the lead' });
    expect(patch.characterArcs[0].transitions).toEqual([
      expect.objectContaining(existingTransition),
    ]);
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
        physicalDescription: 'A compact young rescuer with close-cropped silver hair, a square jaw, and a patched ochre pressure coat.',
        visualNotes: 'ochre and charcoal rescue layers with round analog gauges',
        silhouetteNotes: 'compact torso, broad tool belt, tapered boots',
        visualIdentity: 'rounded rescue hardware against a compact triangular silhouette',
        colorPalette: [{ name: 'rescue ochre', hex: '#c88928', role: 'coat' }],
      }],
      characterArcs: [{
        characterId: 'chr-thin', characterName: 'Lead', want: 'Act alone', need: 'Choose interdependence',
        startState: 'isolated', endState: 'connected',
        transitions: [{ kind: 'decision', atIssue: 2, label: 'asks for help' }],
      }],
    } });
    const r = await establishCharacterFoundation('ser-1', { providerDefault: 'codex', modelDefault: 'gpt-x', effortDefault: 'high' });
    expect(r).toMatchObject({ ran: true, applied: true });
    expect(r.updatedFields).toEqual(expect.arrayContaining([
      'physicalDescription', 'visualNotes', 'silhouetteNotes', 'visualIdentity', 'colorPalette',
    ]));
    expect(stageRunner.runStagedLLM).toHaveBeenCalledWith('pipeline-character-foundation', expect.objectContaining({
      phase: 'pre-arc character foundation',
    }), expect.objectContaining({ providerDefault: 'codex', modelDefault: 'gpt-x', effortDefault: 'high' }));
    expect(seriesSvc.updateSeries.mock.calls.at(-1)[1].characterArcs[0].transitions).toEqual([
      expect.objectContaining({ kind: 'decision', atIssue: 2, label: 'asks for help' }),
    ]);
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
