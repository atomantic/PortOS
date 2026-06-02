import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

const fileStore = new Map();
let stageRunnerSpy;
let stageContextSpy;

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
vi.mock('../../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn((...args) => stageRunnerSpy(...args)),
  extractJson: (raw) => JSON.parse(raw),
  // Large window by default so completeness runs as a single call (mode:
  // 'whole'); a test can set `stageContextSpy` to force a small window.
  resolveStageContext: vi.fn((...args) => (stageContextSpy
    ? stageContextSpy(...args)
    : Promise.resolve({ provider: { id: 'p' }, model: 'm', contextWindow: 1_000_000 }))),
}));

const seriesSvc = await import('./series.js');
const issuesSvc = await import('./issues.js');
const seasonsSvc = await import('./seasons.js');
const worldSvc = await import('../universeBuilder.js');
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

describe('arcPlanner — generateArcOverview', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  it('runs the prompt and returns sanitized arc + seasons preview', async () => {
    const s = await setupSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        logline: 'A foundry city falls and rises.',
        summary: 'Three-season arc...',
        themes: ['legacy', 'labor'],
        protagonistArc: 'From surveyor to founder.',
        seasonOutlines: [
          { number: 1, title: 'The Choir Awakens', logline: 'The pilot.', endingHook: 'silence', episodeCountTarget: 8 },
          { number: 2, title: 'Diaspora', logline: 'The middle.', endingHook: 'reunion', episodeCountTarget: 8 },
          { number: 3, title: 'Salt at the Root', logline: 'The finale.', endingHook: '', episodeCountTarget: 8 },
        ],
      },
      runId: 'run-abc',
      providerId: 'claude',
      model: 'opus-4',
    }));

    const out = await planner.generateArcOverview(s.id);
    expect(stageRunnerSpy).toHaveBeenCalledWith(
      'pipeline-arc-overview',
      expect.objectContaining({ series: expect.objectContaining({ name: 'Salt Run' }) }),
      expect.objectContaining({ returnsJson: true, source: 'pipeline-arc-overview' }),
    );
    expect(out.arc).toMatchObject({
      logline: 'A foundry city falls and rises.',
      themes: ['legacy', 'labor'],
      status: 'draft',
    });
    expect(out.seasons).toHaveLength(3);
    expect(out.seasons[0].id).toMatch(/^sea-/);
    expect(out.seasons[0].title).toBe('The Choir Awakens');
    expect(out.seasons[0].episodeCountTarget).toBe(8);
    expect(out.runId).toBe('run-abc');
  });

  it('drops malformed season outlines and returns the rest', async () => {
    const s = await setupSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        logline: 'L',
        summary: 'S',
        themes: [],
        protagonistArc: 'A',
        seasonOutlines: [
          { number: 1, title: 'Pilot' },
          { number: 0, title: '' },                  // dropped — no title + zero number
          { number: 2, title: 'Aftermath' },
          'this is not an object',                   // dropped
        ],
      },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    const out = await planner.generateArcOverview(s.id);
    expect(out.seasons.map((s) => s.title)).toEqual(['Pilot', 'Aftermath']);
  });

  it('preserves an existing arc.shape when regenerating (LLM does not return shape)', async () => {
    const s = await setupSeries({ arc: { shape: 'rags-to-riches', logline: 'seed', status: 'draft' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'New L', summary: 'New S', themes: [], protagonistArc: '', seasonOutlines: [] },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    const out = await planner.generateArcOverview(s.id);
    expect(out.arc?.shape).toBe('rags-to-riches');
  });

  it('overview context tells the LLM to HONOR the picked shape', async () => {
    const s = await setupSeries({ arc: { shape: 'cinderella', logline: 'seed', status: 'draft' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'L', summary: 'S', themes: [], protagonistArc: 'A', seasonOutlines: [] },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    await planner.generateArcOverview(s.id);
    const ctx = stageRunnerSpy.mock.calls[0][1];
    // pickedShapeId drives the prompt's {{#pickedShapeId}} section — truthy = honor mode.
    expect(ctx.pickedShapeId).toBe('cinderella');
    expect(ctx.shapeGuidance).toContain('Cinderella');
    expect(ctx.allowedShapeIdsCsv).toContain('cinderella');
  });

  it('overview context tells the LLM to PROPOSE a shape when none is set', async () => {
    const s = await setupSeries(); // arc null
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'L', summary: 'S', themes: [], protagonistArc: 'A', shape: 'icarus', seasonOutlines: [] },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    const out = await planner.generateArcOverview(s.id);
    const ctx = stageRunnerSpy.mock.calls[0][1];
    // Empty pickedShapeId triggers the prompt's {{^pickedShapeId}} branch (propose mode).
    expect(ctx.pickedShapeId).toBe('');
    expect(ctx.shapeGuidance).toMatch(/no shape selected/i);
    // LLM-proposed shape round-trips into the persisted arc.
    expect(out.arc?.shape).toBe('icarus');
  });

  it('returns null arc when every identifying field is empty', async () => {
    const s = await setupSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: '', summary: '', themes: [], protagonistArc: '', seasonOutlines: [] },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    const out = await planner.generateArcOverview(s.id);
    expect(out.arc).toBe(null);
    expect(out.seasons).toEqual([]);
  });

  it('feeds the linked world\'s categories + composite sheets into the prompt context', async () => {
    // Create a world with factions + a composite sheet, then a series linked to it.
    const world = await worldSvc.createUniverse({
      name: 'Clandestiny',
      starterPrompt: 'paranormal investigators in a candy-bright city',
      logline: 'World logline',
      premise: 'World premise',
      styleNotes: 'cel-shaded, pastels',
      influences: { embrace: ['Moebius', 'Saga'], avoid: ['gritty'] },
      categories: {
        factions: { variations: [
          { label: 'The Lollipop Bureau', prompt: 'pastel public-facing agency' },
          { label: 'The Velvet Null', prompt: 'minimalist rival' },
        ] },
      },
      // Canon characters (Phase B contract — first-class named entities; the
      // `characters` default category was retired in Phase A schema v4).
      characters: [
        { name: 'Mira Holt', physicalDescription: 'field detective in a chartreuse coat' },
      ],
      objects: [
        { name: 'The Tongue', description: 'an artifact that absorbs language' },
      ],
      compositeSheets: [
        { kind: 'reference_sheet', label: 'Rival agencies branding', prompt: 'comparison sheet' },
      ],
    });
    const s = await setupSeries({ universeId: world.id });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        logline: 'L', summary: 'S', themes: [], protagonistArc: 'A',
        seasonOutlines: [{ number: 1, title: 'Pilot' }],
      },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    await planner.generateArcOverview(s.id);

    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.worldName).toBe('Clandestiny');
    expect(ctx.worldCategoriesText).toContain('factions');
    expect(ctx.worldCategoriesText).toContain('The Lollipop Bureau');
    expect(ctx.worldCategoriesText).toContain('The Velvet Null');
    // Phase B: canon entries surface in their own context field so the LLM
    // can reference characters/places/objects by name (independent of
    // categories, which stay as the exploratory-variation surface).
    expect(ctx.worldCanonText).toContain('Mira Holt');
    expect(ctx.worldCanonText).toContain('field detective');
    expect(ctx.worldCanonText).toContain('The Tongue');
    expect(ctx.worldCompositesText).toContain('Rival agencies branding');
    expect(ctx.worldInfluencesEmbrace).toContain('Moebius');
    expect(ctx.worldInfluencesAvoid).toContain('gritty');
  });

  it('renders an "(no linked world)" placeholder when the series has no universeId', async () => {
    const s = await setupSeries({ universeId: null });
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'L', summary: 'S', themes: [], protagonistArc: 'A', seasonOutlines: [] },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    await planner.generateArcOverview(s.id);
    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.worldName).toMatch(/no linked world/i);
    expect(ctx.worldCategoriesText).toMatch(/none/i);
    expect(ctx.worldCanonText).toMatch(/none/i);
  });

  it('throws ERR_VALIDATION + skips the LLM call when arc is locked', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { locked: { arc: true } });
    stageRunnerSpy = vi.fn();
    await expect(planner.generateArcOverview(s.id))
      .rejects.toMatchObject({ code: planner.ERR_VALIDATION });
    expect(stageRunnerSpy).not.toHaveBeenCalled();
  });
});

describe('arcPlanner — generateSeasonEpisodes', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  async function setupSeriesWithSeasons() {
    const s = await setupSeries();
    const s1 = await seasonsSvc.createSeason(s.id, {
      title: 'Pilot',
      logline: 'season 1 logline',
      synopsis: 'season 1 synopsis',
      episodeCountTarget: 8,
    });
    const s2 = await seasonsSvc.createSeason(s.id, {
      title: 'Diaspora',
      logline: 'season 2 logline',
      synopsis: 'season 2 synopsis',
      episodeCountTarget: 8,
    });
    return { series: await seriesSvc.getSeries(s.id), seasons: [s1, s2] };
  }

  it('builds prior-seasons context only for seasons before the target', async () => {
    const { series, seasons } = await setupSeriesWithSeasons();
    stageRunnerSpy = vi.fn(async () => ({
      content: { episodes: [{ number: 1, title: 'Ep 1', logline: '', synopsis: '', arcRole: 'pilot' }] },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    await planner.generateSeasonEpisodes(series.id, seasons[1].id);
    const call = stageRunnerSpy.mock.calls[0];
    const ctx = call[1];
    expect(ctx.season.title).toBe('Diaspora');
    expect(ctx.priorSeasonsContext).toContain('Season 1 — Pilot');
    expect(ctx.priorSeasonsContext).not.toContain('Diaspora');
  });

  it('shows "first season" copy for the season-1 case', async () => {
    const { series, seasons } = await setupSeriesWithSeasons();
    stageRunnerSpy = vi.fn(async () => ({
      content: { episodes: [] }, runId: 'r1', providerId: 'p', model: 'm',
    }));
    await planner.generateSeasonEpisodes(series.id, seasons[0].id);
    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.priorSeasonsContext).toContain('first season');
  });

  it('passes shape guidance + per-season curve position into the episodes context', async () => {
    const { series, seasons } = await setupSeriesWithSeasons();
    await seriesSvc.updateSeries(series.id, { arc: { shape: 'man-in-hole', logline: 'L', status: 'draft' } });
    stageRunnerSpy = vi.fn(async () => ({ content: { episodes: [] }, runId: 'r1', providerId: 'p', model: 'm' }));
    await planner.generateSeasonEpisodes(series.id, seasons[1].id);
    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.shapeGuidance).toContain('Man in Hole');
    expect(ctx.shapePosition).toContain('Volume 2 of 2');
    expect(ctx.arc.shape).toBe('man-in-hole');
  });

  it('shape-position falls back to a neutral note when no shape is selected', async () => {
    const { series, seasons } = await setupSeriesWithSeasons();
    stageRunnerSpy = vi.fn(async () => ({ content: { episodes: [] }, runId: 'r1', providerId: 'p', model: 'm' }));
    await planner.generateSeasonEpisodes(series.id, seasons[0].id);
    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.shapePosition).toMatch(/no story shape selected/i);
    expect(ctx.shapeGuidance).toMatch(/no Vonnegut story shape selected/i);
  });

  it('rejects ERR_VALIDATION when the season has neither logline nor synopsis', async () => {
    const s = await setupSeries();
    const bare = await seasonsSvc.createSeason(s.id, { title: 'Bare', number: 1 });
    await expect(planner.generateSeasonEpisodes(s.id, bare.id))
      .rejects.toMatchObject({ code: planner.ERR_VALIDATION });
  });

  it('rejects ERR_VALIDATION for an unknown season id', async () => {
    const s = await setupSeries();
    await expect(planner.generateSeasonEpisodes(s.id, 'sea-nope'))
      .rejects.toMatchObject({ code: planner.ERR_VALIDATION });
  });

  it('refuses + skips the LLM call when the target season is locked', async () => {
    const { series, seasons } = await setupSeriesWithSeasons();
    await seasonsSvc.updateSeason(series.id, seasons[0].id, { locked: true });
    stageRunnerSpy = vi.fn();
    await expect(planner.generateSeasonEpisodes(series.id, seasons[0].id))
      .rejects.toMatchObject({ code: planner.ERR_VALIDATION });
    expect(stageRunnerSpy).not.toHaveBeenCalled();
  });

  it('shapes episodes, drops untitled entries, and validates arcRole', async () => {
    const { series, seasons } = await setupSeriesWithSeasons();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        episodes: [
          { number: 1, title: 'Ep 1', logline: 'L1', synopsis: 'S1', primaryCharacters: ['LINA'], arcRole: 'pilot' },
          { number: 2, title: '', logline: 'no title' },                              // dropped
          { number: 3, title: 'Ep 3', arcRole: 'bogus-role', primaryCharacters: ['LINA', 42, '  '] },
        ],
      },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    const out = await planner.generateSeasonEpisodes(series.id, seasons[0].id);
    expect(out.episodes.map((e) => e.title)).toEqual(['Ep 1', 'Ep 3']);
    expect(out.episodes[1].arcRole).toBe(null);            // invalid role drops to null
    expect(out.episodes[1].primaryCharacters).toEqual(['LINA']); // non-string + blank entries filtered
  });

  it('rejects the `custom` length sentinel and derives a finale-role fallback to `finale`', async () => {
    const { series, seasons } = await setupSeriesWithSeasons();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        episodes: [
          // LLM emitted `custom` without page/minute companions → reject sentinel,
          // fall back via arcRole. arcRole=finale → finale preset.
          { number: 1, title: 'Finale', arcRole: 'finale', lengthProfile: 'custom' },
          // arcRole=midpoint and missing lengthProfile → default profile (standard).
          { number: 2, title: 'Midpoint', arcRole: 'midpoint' },
          // Valid preset is kept as-is.
          { number: 3, title: 'Extra', lengthProfile: 'extended' },
        ],
      },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    const out = await planner.generateSeasonEpisodes(series.id, seasons[0].id);
    const byTitle = Object.fromEntries(out.episodes.map((e) => [e.title, e]));
    expect(byTitle.Finale.lengthProfile).toBe('finale');
    expect(byTitle.Midpoint.lengthProfile).toBe('standard');
    expect(byTitle.Extra.lengthProfile).toBe('extended');
  });
});

describe('arcPlanner — commitEpisodesToIssues', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
  });

  it('mints one issue per episode with arc pointers + idea seed', async () => {
    const s = await setupSeries();
    const episodes = [
      { number: 1, title: 'Pilot', arcRole: 'pilot', logline: 'L1', synopsis: 'S1', lengthProfile: 'standard' },
      { number: 2, title: 'Rising', arcRole: 'complication', logline: 'L2', synopsis: '', lengthProfile: 'short' },
    ];
    const created = await planner.commitEpisodesToIssues(s.id, null, episodes);
    expect(created).toHaveLength(2);
    expect(created[0].title).toBe('Pilot');
    expect(created[0].arcPosition).toBe(1);
    expect(created[0].arcRole).toBe('pilot');
    expect(created[0].stages.idea.input).toBe('L1\n\nS1');
    expect(created[0].stages.idea.status).toBe('edited');
    // No synopsis ⇒ idea seed is the bare logline and the stage stays 'empty'.
    expect(created[1].stages.idea.input).toBe('L2');
    expect(created[1].stages.idea.status).toBe('empty');
  });

  it('reads the series once for the whole batch instead of once per episode', async () => {
    const s = await setupSeries();
    const episodes = [1, 2, 3, 4].map((n) => ({
      number: n, title: `E${n}`, arcRole: 'beat', logline: `L${n}`, synopsis: `S${n}`,
    }));
    const spy = vi.spyOn(seriesSvc, 'getSeries');
    const created = await planner.commitEpisodesToIssues(s.id, null, episodes);
    const callCount = spy.mock.calls.length;
    spy.mockRestore();
    expect(created).toHaveLength(4);
    // The preload fetches once; each createIssue's renumber pass reuses it —
    // the pre-fix shape was one getSeries per episode (4 reads).
    expect(callCount).toBe(1);
  });

  it('honors a caller-supplied preloadedSeries with zero getSeries reads', async () => {
    const s = await setupSeries();
    const series = await seriesSvc.getSeries(s.id);
    const episodes = [{ number: 1, title: 'Solo', arcRole: 'pilot', logline: 'L', synopsis: 'S' }];
    const spy = vi.spyOn(seriesSvc, 'getSeries');
    const created = await planner.commitEpisodesToIssues(s.id, null, episodes, { preloadedSeries: series });
    const callCount = spy.mock.calls.length;
    spy.mockRestore();
    expect(created).toHaveLength(1);
    expect(callCount).toBe(0);
  });
});

describe('arcPlanner — verifyArc', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  it('throws 400 NO_ARC if the series has no arc to verify', async () => {
    const s = await setupSeries();
    await expect(planner.verifyArc(s.id))
      .rejects.toMatchObject({ status: 400, code: 'PIPELINE_NO_ARC' });
  });

  it('builds the seasons tree with grouped + ungrouped issues, then runs the prompt', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'Whole-arc pitch', summary: 'A long summary', themes: ['legacy'] },
    });
    const sea = await seasonsSvc.createSeason(s.id, { title: 'Pilot', synopsis: 'season synopsis' });
    const grouped = await issuesSvc.createIssue({ seriesId: s.id, title: 'Ep 1', seasonId: sea.id, arcPosition: 1 });
    const ungrouped = await issuesSvc.createIssue({ seriesId: s.id, title: 'Floating' });

    stageRunnerSpy = vi.fn(async () => ({
      content: { issues: [{ severity: 'medium', location: 'season:1', problem: 'one beat', suggestion: 'add another' }] },
      runId: 'r1', providerId: 'p', model: 'm',
    }));

    const out = await planner.verifyArc(s.id);
    const ctx = stageRunnerSpy.mock.calls[0][1];
    const tree = JSON.parse(ctx.seasonsTreeJson);
    expect(tree[0].title).toBe('Pilot');
    expect(tree[0].episodes.map((e) => e.title)).toEqual([grouped.title]);
    expect(tree[tree.length - 1].title).toBe('(ungrouped issues)');
    expect(tree[tree.length - 1].episodes.map((e) => e.title)).toEqual([ungrouped.title]);

    expect(out.issues).toEqual([
      { severity: 'medium', location: 'season:1', problem: 'one beat', suggestion: 'add another' },
    ]);
  });

  it('drops malformed verify issues + defaults severity to medium', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        issues: [
          { severity: 'high', problem: 'real one' },
          { problem: '' },                          // dropped — no problem
          { problem: 'no severity' },               // kept — severity defaults to medium
          { severity: 'bogus', problem: 'invalid severity', location: 'season:2' },
        ],
      },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    const out = await planner.verifyArc(s.id);
    expect(out.issues.map((i) => i.problem)).toEqual(['real one', 'no severity', 'invalid severity']);
    expect(out.issues[1].severity).toBe('medium');
    expect(out.issues[2].severity).toBe('medium');
  });
});

describe('arcPlanner — verifyVolume', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  it('throws 400 NO_ARC if the series has no arc to anchor the volume against', async () => {
    const s = await setupSeries();
    const sea = await seasonsSvc.createSeason(s.id, { title: 'V1', logline: 'l' });
    await expect(planner.verifyVolume(s.id, sea.id))
      .rejects.toMatchObject({ status: 400, code: 'PIPELINE_NO_ARC' });
  });

  it('throws NOT_FOUND when the season id does not exist on the series', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    await expect(planner.verifyVolume(s.id, 'sea-does-not-exist'))
      .rejects.toMatchObject({ code: 'PIPELINE_SEASON_NOT_FOUND' });
  });

  it('emits beats for expanded issues and synopsis for un-expanded ones, never both', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'Whole arc', summary: 'sum', themes: ['legacy'] },
    });
    const sea = await seasonsSvc.createSeason(s.id, {
      title: 'V1', logline: 'volume l', synopsis: 'volume s', endingHook: 'hook',
      episodeCountTarget: 3,
    });
    // Issue 1: has beats (LLM output filled). Expect `beats` field, no `synopsis`.
    const beatsIssue = await issuesSvc.createIssue({
      seriesId: s.id, title: 'Ep 1', seasonId: sea.id, arcPosition: 1,
      stages: { idea: { input: 'seed', output: 'beat 1\nbeat 2\nbeat 3', status: 'ready' } },
    });
    // Issue 2: synopsis-only (idea.input set, output empty). Expect `synopsis`,
    // no `beats`.
    const synopsisIssue = await issuesSvc.createIssue({
      seriesId: s.id, title: 'Ep 2', seasonId: sea.id, arcPosition: 2,
      stages: { idea: { input: 'just a seed', status: 'edited' } },
    });
    // Issue from another season — must not leak into this volume's payload.
    const otherSeason = await seasonsSvc.createSeason(s.id, { title: 'V2', logline: 'other' });
    await issuesSvc.createIssue({
      seriesId: s.id, title: 'Other vol issue', seasonId: otherSeason.id, arcPosition: 1,
      stages: { idea: { input: 'other', output: 'other beats', status: 'ready' } },
    });

    stageRunnerSpy = vi.fn(async () => ({
      content: { issues: [{ severity: 'high', problem: 'X', location: 'episode:1', suggestion: 'Y' }] },
      runId: 'rv', providerId: 'p', model: 'm',
    }));

    const out = await planner.verifyVolume(s.id, sea.id);
    expect(stageRunnerSpy).toHaveBeenCalledWith(
      'pipeline-volume-verify',
      expect.any(Object),
      expect.objectContaining({ returnsJson: true, source: 'pipeline-volume-verify' }),
    );

    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.volume.title).toBe('V1');
    expect(ctx.volume.endingHook).toBe('hook');

    const volumeIssues = JSON.parse(ctx.volumeIssuesJson);
    expect(volumeIssues).toHaveLength(2);
    expect(volumeIssues[0].title).toBe(beatsIssue.title);
    expect(volumeIssues[0].beats).toContain('beat 1');
    expect(volumeIssues[0]).not.toHaveProperty('synopsis');
    expect(volumeIssues[1].title).toBe(synopsisIssue.title);
    expect(volumeIssues[1].synopsis).toBe('just a seed');
    expect(volumeIssues[1]).not.toHaveProperty('beats');

    expect(out.issues).toEqual([
      { severity: 'high', location: 'episode:1', problem: 'X', suggestion: 'Y' },
    ]);
    expect(out.seasonId).toBe(sea.id);
  });

  it('includes only the immediate-neighbor volumes (prior + next), excluding self', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const v1 = await seasonsSvc.createSeason(s.id, { title: 'V1', logline: 'one' });
    const v2 = await seasonsSvc.createSeason(s.id, { title: 'V2', logline: 'two', endingHook: 'hook2' });
    const v3 = await seasonsSvc.createSeason(s.id, { title: 'V3', logline: 'three' });
    const v4 = await seasonsSvc.createSeason(s.id, { title: 'V4', logline: 'four' });

    stageRunnerSpy = vi.fn(async () => ({
      content: { issues: [] }, runId: 'r', providerId: 'p', model: 'm',
    }));
    // Verifying the middle volume should expose V2 (prior) + V4 (next), never V1 or V3 itself.
    await planner.verifyVolume(s.id, v3.id);
    const ctx = stageRunnerSpy.mock.calls[0][1];
    const neighbors = JSON.parse(ctx.neighborsJson);
    expect(neighbors.map((n) => n.position)).toEqual(['prior', 'next']);
    expect(neighbors[0].title).toBe('V2');
    expect(neighbors[0].endingHook).toBe('hook2');
    expect(neighbors[1].title).toBe('V4');
    expect(neighbors.find((n) => n.title === 'V3')).toBeUndefined();
    expect(neighbors.find((n) => n.title === 'V1')).toBeUndefined();

    // First volume has no prior, only next.
    stageRunnerSpy.mockClear();
    stageRunnerSpy.mockImplementation(async () => ({ content: { issues: [] }, runId: 'r', providerId: 'p', model: 'm' }));
    await planner.verifyVolume(s.id, v1.id);
    const firstNeighbors = JSON.parse(stageRunnerSpy.mock.calls[0][1].neighborsJson);
    expect(firstNeighbors.map((n) => n.position)).toEqual(['next']);

    // Last volume has no next, only prior.
    stageRunnerSpy.mockClear();
    stageRunnerSpy.mockImplementation(async () => ({ content: { issues: [] }, runId: 'r', providerId: 'p', model: 'm' }));
    await planner.verifyVolume(s.id, v4.id);
    const lastNeighbors = JSON.parse(stageRunnerSpy.mock.calls[0][1].neighborsJson);
    expect(lastNeighbors.map((n) => n.position)).toEqual(['prior']);
  });

  it('returns empty issues for a clean volume + drops malformed entries', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const sea = await seasonsSvc.createSeason(s.id, { title: 'V', logline: 'l' });
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        issues: [
          { problem: '' },                                  // dropped
          { severity: 'low', problem: 'real but tiny' },    // kept
          'not an object',                                  // dropped
        ],
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const out = await planner.verifyVolume(s.id, sea.id);
    expect(out.issues.map((i) => i.problem)).toEqual(['real but tiny']);
  });

  it('threads the shape + per-volume curve placement into the verifier context', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L', shape: 'icarus', status: 'draft' } });
    const v1 = await seasonsSvc.createSeason(s.id, { title: 'V1', number: 1, logline: 'l1' });
    await seasonsSvc.createSeason(s.id, { title: 'V2', number: 2, logline: 'l2' });
    await seasonsSvc.createSeason(s.id, { title: 'V3', number: 3, logline: 'l3' });
    stageRunnerSpy = vi.fn(async () => ({ content: { issues: [] }, runId: 'r', providerId: 'p', model: 'm' }));
    await planner.verifyVolume(s.id, v1.id);
    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.shapeGuidance).toContain('Icarus');
    expect(ctx.volumeShapePosition).toContain('Volume 1 of 3');
    expect(ctx.volumeShapePosition).toContain('Icarus');
  });

  it('shape position falls back to a neutral note when no shape is selected', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L', status: 'draft' } });
    const v1 = await seasonsSvc.createSeason(s.id, { title: 'V1', number: 1, logline: 'l1' });
    stageRunnerSpy = vi.fn(async () => ({ content: { issues: [] }, runId: 'r', providerId: 'p', model: 'm' }));
    await planner.verifyVolume(s.id, v1.id);
    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.volumeShapePosition).toMatch(/no story shape selected/i);
  });
});

describe('arcPlanner — resolveVerifyIssues', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  it('throws 400 NO_ARC if the series has no arc to resolve', async () => {
    const s = await setupSeries();
    await expect(planner.resolveVerifyIssues(s.id, { findings: [{ problem: 'X' }] }))
      .rejects.toMatchObject({ status: 400, code: 'PIPELINE_NO_ARC' });
  });

  it('persists the LLM-patched arc + seasons and preserves existing season ids', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'old logline', summary: 'old summary' } });
    const existingSeason = await seasonsSvc.createSeason(s.id, {
      title: 'Season 1',
      logline: 'old s1 logline',
      synopsis: 'old s1 synopsis',
      episodeCountTarget: 4,
    });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'new logline', summary: 'new summary', themes: ['legacy'], protagonistArc: 'arc' },
        seasons: [
          {
            id: existingSeason.id,
            number: 1,
            title: 'Season 1',
            logline: 'new s1 logline',
            synopsis: 'new s1 synopsis',
            endingHook: 'hook',
            episodeCountTarget: 12,
          },
        ],
        notes: '',
      },
      runId: 'r1', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'medium', problem: 'count vs weight', suggestion: 'raise count' }],
    });

    expect(out.applied).toBe(true);
    expect(out.series.arc.logline).toBe('new logline');
    expect(out.series.seasons).toHaveLength(1);
    expect(out.series.seasons[0].id).toBe(existingSeason.id); // id preserved
    expect(out.series.seasons[0].episodeCountTarget).toBe(12);
    expect(out.series.seasons[0].logline).toBe('new s1 logline');

    const call = stageRunnerSpy.mock.calls[0];
    expect(call[0]).toBe('pipeline-arc-resolve');
    expect(call[1]).toMatchObject({
      findingsJson: expect.stringContaining('count vs weight'),
      recommendedStructure: expect.any(String),
    });
  });

  it('re-runs verify when no findings are supplied and short-circuits on a clean arc', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    // First call (from verify) returns no issues — resolve should short-circuit
    // without making a second LLM call.
    stageRunnerSpy = vi.fn(async () => ({
      content: { issues: [] },
      runId: 'verify-r', providerId: 'p', model: 'm',
    }));
    const out = await planner.resolveVerifyIssues(s.id, {});
    expect(out.applied).toBe(false);
    expect(out.notes).toMatch(/no findings/i);
    expect(stageRunnerSpy).toHaveBeenCalledTimes(1);
    expect(stageRunnerSpy.mock.calls[0][0]).toBe('pipeline-arc-verify');
  });

  it('remaps child issues off dropped seasonIds onto matched replacements', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const oldS1 = await seasonsSvc.createSeason(s.id, { title: 'The Velvet Pouch', episodeCountTarget: 3 });
    const oldS2 = await seasonsSvc.createSeason(s.id, { title: 'Six Blocks Down', episodeCountTarget: 3 });
    const oldS3 = await seasonsSvc.createSeason(s.id, { title: 'The City Looks Back', episodeCountTarget: 3 });

    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS1.id, title: 'Pilot' });
    const i2 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS2.id, title: 'Middle' });
    const i3 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS3.id, title: 'Finale' });

    // LLM returns seasons by title without preserving ids; the remap must
    // reattach orphaned issues via normalized title match.
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        seasons: [
          { number: 1, title: 'The Velvet Pouch', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 3 },
          { number: 2, title: 'Six Blocks Down', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 3 },
          { number: 3, title: 'The City Looks Back', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 3 },
        ],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'medium', problem: 'X', suggestion: 'Y' }],
    });

    expect(out.applied).toBe(true);
    expect(out.series.seasons).toHaveLength(3);
    const [newS1, newS2, newS3] = out.series.seasons;
    expect(newS1.id).not.toBe(oldS1.id); // freshly minted

    const finalI1 = await issuesSvc.getIssue(i1.id);
    const finalI2 = await issuesSvc.getIssue(i2.id);
    const finalI3 = await issuesSvc.getIssue(i3.id);
    expect(finalI1.seasonId).toBe(newS1.id);
    expect(finalI2.seasonId).toBe(newS2.id);
    expect(finalI3.seasonId).toBe(newS3.id);
  });

  it('drops orphans to null seasonId when no replacement can be matched', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const oldS = await seasonsSvc.createSeason(s.id, { title: 'Only Season', episodeCountTarget: 3 });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS.id, title: 'Orphan' });

    // LLM returns zero seasons — nothing to remap to, issue should go ungrouped.
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        seasons: [],
        notes: 'collapsed',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'medium', problem: 'X', suggestion: 'Y' }],
    });

    const finalI1 = await issuesSvc.getIssue(i1.id);
    expect(finalI1.seasonId).toBeNull();
  });

  it('preserves series.arc.readerMap when the resolve LLM does not author one', async () => {
    // Regression for the drift between generateArcOverview (which preserves
    // readerMap) and resolveVerifyIssues (which silently wiped it pre-fix).
    const s = await setupSeries();
    const priorReaderMap = {
      hooks: [{ id: 'rm-h-1', label: 'why is the foundry silent', atArcPosition: 0.1, note: '' }],
      payoffs: [],
      beats: [],
      cliffhangers: [],
      status: 'draft',
    };
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'L', summary: 'S', shape: 'man-in-hole', readerMap: priorReaderMap },
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        // The resolve prompt doesn't ask the LLM for a reader map — make sure
        // omitting it doesn't wipe the user's existing one.
        arc: { logline: 'L2', summary: 'S2', themes: [], protagonistArc: '' },
        seasons: [],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'medium', problem: 'X', suggestion: 'Y' }],
    });
    expect(out.applied).toBe(true);
    expect(out.series.arc.logline).toBe('L2');
    // shape and readerMap come from the prior series.arc and must survive.
    expect(out.series.arc.shape).toBe('man-in-hole');
    expect(out.series.arc.readerMap?.hooks?.[0]?.label).toBe('why is the foundry silent');
  });
});

describe('arcPlanner — commitSeasonsWithRemap', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  it('remaps child issues onto title-matched replacement seasons (the regenerate-arc path)', async () => {
    const s = await setupSeries();
    const oldS1 = await seasonsSvc.createSeason(s.id, { title: 'The Velvet Pouch', episodeCountTarget: 3 });
    const oldS2 = await seasonsSvc.createSeason(s.id, { title: 'Six Blocks Down', episodeCountTarget: 3 });

    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS1.id, title: 'Pilot' });
    const i2 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS2.id, title: 'Middle' });

    const cur = await seriesSvc.getSeries(s.id);
    const freshSeasons = [
      // Same titles, brand-new ids — exactly what shapeSeasonOutlines emits.
      { id: 'sea-fresh-1', number: 1, title: 'The Velvet Pouch', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 3, themes: [] },
      { id: 'sea-fresh-2', number: 2, title: 'Six Blocks Down', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 3, themes: [] },
    ];
    const out = await planner.commitSeasonsWithRemap(cur, {
      arc: { logline: 'L', summary: '', themes: [], protagonistArc: '', shape: null, status: 'draft' },
      seasons: freshSeasons,
    });

    expect(out.reassignedIssueCount).toBe(2);
    expect(out.series.seasons.map((s) => s.id)).toEqual(['sea-fresh-1', 'sea-fresh-2']);

    const finalI1 = await issuesSvc.getIssue(i1.id);
    const finalI2 = await issuesSvc.getIssue(i2.id);
    expect(finalI1.seasonId).toBe('sea-fresh-1');
    expect(finalI2.seasonId).toBe('sea-fresh-2');
  });

  it('does nothing to issues when seasons[] preserves existing ids', async () => {
    const s = await setupSeries();
    const oldS1 = await seasonsSvc.createSeason(s.id, { title: 'Keep me', episodeCountTarget: 3 });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS1.id, title: 'Pilot' });

    const cur = await seriesSvc.getSeries(s.id);
    const out = await planner.commitSeasonsWithRemap(cur, {
      arc: { logline: 'L', summary: '', themes: [], protagonistArc: '', shape: null, status: 'draft' },
      seasons: [{ ...oldS1, logline: 'updated' }],
    });
    expect(out.reassignedIssueCount).toBe(0);
    const finalI1 = await issuesSvc.getIssue(i1.id);
    expect(finalI1.seasonId).toBe(oldS1.id);
  });

  it('drops orphans to null when no remap target exists (collapsed seasons)', async () => {
    const s = await setupSeries();
    const oldS1 = await seasonsSvc.createSeason(s.id, { title: 'Only', episodeCountTarget: 3 });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS1.id, title: 'Orphan' });

    const cur = await seriesSvc.getSeries(s.id);
    const out = await planner.commitSeasonsWithRemap(cur, {
      arc: { logline: 'L', summary: '', themes: [], protagonistArc: '', shape: null, status: 'draft' },
      seasons: [],
    });
    expect(out.reassignedIssueCount).toBe(1);
    const finalI1 = await issuesSvc.getIssue(i1.id);
    expect(finalI1.seasonId).toBeNull();
  });

  it('preserves locked arc fields when commit rewrites the arc', async () => {
    const s = await setupSeries({
      arc: {
        logline: 'KEEP THIS LOGLINE',
        summary: 'rewrite the summary',
        themes: ['keep', 'these'],
        protagonistArc: 'rewrite the pa',
        shape: 'rags-to-riches',
        status: 'draft',
      },
      locked: { arcFields: { logline: true, themes: true } },
    });
    const cur = await seriesSvc.getSeries(s.id);
    const out = await planner.commitSeasonsWithRemap(cur, {
      arc: {
        logline: 'NEW LOGLINE (should be ignored)',
        summary: 'a fresh summary',
        themes: ['fresh', 'replaced'],
        protagonistArc: 'a fresh pa',
        shape: 'icarus',
        status: 'draft',
      },
      seasons: [],
    });
    // Locked fields preserved verbatim from the existing arc.
    expect(out.series.arc.logline).toBe('KEEP THIS LOGLINE');
    expect(out.series.arc.themes).toEqual(['keep', 'these']);
    // Unlocked fields took the new value.
    expect(out.series.arc.summary).toBe('a fresh summary');
    expect(out.series.arc.protagonistArc).toBe('a fresh pa');
    expect(out.series.arc.shape).toBe('icarus');
  });

  it('honors arc field locks toggled after the caller snapshot was read', async () => {
    const s = await setupSeries({
      arc: {
        logline: 'original logline',
        summary: 'original summary',
        themes: [],
        protagonistArc: '',
        shape: null,
        status: 'draft',
      },
    });
    const stale = await seriesSvc.getSeries(s.id);
    await seriesSvc.updateSeries(s.id, {
      arc: { ...stale.arc, logline: 'latest locked logline' },
      locked: { arcFields: { logline: true } },
    });
    const out = await planner.commitSeasonsWithRemap(stale, {
      arc: {
        ...stale.arc,
        logline: 'incoming overwrite',
        summary: 'incoming summary',
      },
      seasons: [],
    });
    expect(out.series.arc.logline).toBe('latest locked logline');
    expect(out.series.arc.summary).toBe('incoming summary');
  });
});

describe('arcPlanner — mergeSeasonsWithLocks', () => {
  it('replaces an LLM-proposed season with the existing locked record when ids match', () => {
    const current = [
      { id: 'sea-a', number: 1, title: 'Locked Title', logline: 'locked log', locked: true },
      { id: 'sea-b', number: 2, title: 'Unlocked', logline: 'old log', locked: false },
    ];
    const next = [
      { id: 'sea-a', number: 1, title: 'LLM rewrite', logline: 'LLM log' },
      { id: 'sea-b', number: 2, title: 'Unlocked rewritten', logline: 'new log' },
    ];
    const merged = planner.__testing.mergeSeasonsWithLocks(current, next);
    expect(merged[0]).toBe(current[0]);
    expect(merged[0].title).toBe('Locked Title');
    expect(merged[1].title).toBe('Unlocked rewritten');
  });

  it('re-inserts a locked season that the LLM dropped from the new shape', () => {
    const current = [
      { id: 'sea-a', number: 1, title: 'Drop me', locked: true },
      { id: 'sea-b', number: 2, title: 'Keep me', locked: false },
    ];
    const next = [
      { id: 'sea-b', number: 2, title: 'Keep me' },
    ];
    const merged = planner.__testing.mergeSeasonsWithLocks(current, next);
    expect(merged).toHaveLength(2);
    expect(merged.find((s) => s.id === 'sea-a')).toBe(current[0]);
  });

  it('returns next unchanged when no current season is locked', () => {
    const current = [{ id: 'sea-a', number: 1, locked: false }];
    const next = [{ id: 'sea-a', number: 1, title: 'rewrite' }];
    expect(planner.__testing.mergeSeasonsWithLocks(current, next)).toBe(next);
  });

  it('returns next unchanged when currentSeasons is not an array', () => {
    const next = [{ id: 'sea-a', number: 1 }];
    expect(planner.__testing.mergeSeasonsWithLocks(undefined, next)).toBe(next);
    expect(planner.__testing.mergeSeasonsWithLocks(null, next)).toBe(next);
  });

  it('returns nextSeasons untouched when nextSeasons is not an array', () => {
    expect(planner.__testing.mergeSeasonsWithLocks([{ id: 'a', locked: true }], null)).toBeNull();
    expect(planner.__testing.mergeSeasonsWithLocks([{ id: 'a', locked: true }], undefined)).toBeUndefined();
  });
});

describe('arcPlanner — commitSeasonsWithRemap (season locks)', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  it('preserves a locked season verbatim when the LLM tries to rewrite its content', async () => {
    const s = await setupSeries();
    const s1 = await seasonsSvc.createSeason(s.id, {
      title: 'Locked Title',
      logline: 'locked logline',
      synopsis: 'locked synopsis',
      episodeCountTarget: 3,
      number: 1,
    });
    await seasonsSvc.updateSeason(s.id, s1.id, { locked: true });
    const cur = await seriesSvc.getSeries(s.id);
    const out = await planner.commitSeasonsWithRemap(cur, {
      arc: { logline: 'L', summary: '', themes: [], protagonistArc: '', shape: null, status: 'draft' },
      seasons: [
        // LLM tries to rewrite the locked season's content under the same id.
        { id: s1.id, number: 1, title: 'LLM rewrite', logline: 'LLM logline', synopsis: 'LLM synopsis', endingHook: '', episodeCountTarget: 9, themes: [] },
      ],
    });
    const persisted = out.series.seasons.find((x) => x.id === s1.id);
    expect(persisted.title).toBe('Locked Title');
    expect(persisted.logline).toBe('locked logline');
    expect(persisted.synopsis).toBe('locked synopsis');
    expect(persisted.episodeCountTarget).toBe(3);
    expect(persisted.locked).toBe(true);
  });

  it('re-inserts a locked season the LLM dropped, with no issue reassignment', async () => {
    const s = await setupSeries();
    const s1 = await seasonsSvc.createSeason(s.id, { title: 'Locked', episodeCountTarget: 3, number: 1 });
    await seasonsSvc.updateSeason(s.id, s1.id, { locked: true });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: s1.id, title: 'Pilot' });
    const cur = await seriesSvc.getSeries(s.id);
    const out = await planner.commitSeasonsWithRemap(cur, {
      arc: { logline: 'L', summary: '', themes: [], protagonistArc: '', shape: null, status: 'draft' },
      // LLM proposed dropping the locked season entirely.
      seasons: [],
    });
    expect(out.series.seasons.map((x) => x.id)).toContain(s1.id);
    expect(out.reassignedIssueCount).toBe(0);
    const finalI1 = await issuesSvc.getIssue(i1.id);
    expect(finalI1.seasonId).toBe(s1.id);
  });

  it('still rewrites unlocked sibling seasons while preserving the locked one', async () => {
    const s = await setupSeries();
    const locked = await seasonsSvc.createSeason(s.id, { title: 'Frozen', episodeCountTarget: 4, number: 1 });
    await seasonsSvc.updateSeason(s.id, locked.id, { locked: true });
    const unlocked = await seasonsSvc.createSeason(s.id, { title: 'Editable', episodeCountTarget: 4, number: 2 });
    const cur = await seriesSvc.getSeries(s.id);
    const out = await planner.commitSeasonsWithRemap(cur, {
      arc: { logline: 'L', summary: '', themes: [], protagonistArc: '', shape: null, status: 'draft' },
      seasons: [
        { id: locked.id, number: 1, title: 'LLM rewrite of frozen', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 1, themes: [] },
        { id: unlocked.id, number: 2, title: 'Editable v2', logline: 'updated', synopsis: '', endingHook: '', episodeCountTarget: 5, themes: [] },
      ],
    });
    const frozenAfter = out.series.seasons.find((x) => x.id === locked.id);
    const editableAfter = out.series.seasons.find((x) => x.id === unlocked.id);
    expect(frozenAfter.title).toBe('Frozen');
    expect(frozenAfter.locked).toBe(true);
    expect(editableAfter.title).toBe('Editable v2');
    expect(editableAfter.episodeCountTarget).toBe(5);
  });
});

describe('arcPlanner — mergeArcWithLocks', () => {
  it('replaces locked fields with the current arc values', () => {
    const current = { logline: 'a', summary: 'b', themes: ['t1'], protagonistArc: 'c', shape: 's1' };
    const next = { logline: 'A', summary: 'B', themes: ['t2'], protagonistArc: 'C', shape: 's2' };
    const merged = planner.__testing.mergeArcWithLocks(current, next, { logline: true, themes: true });
    expect(merged.logline).toBe('a');
    expect(merged.themes).toEqual(['t1']);
    expect(merged.summary).toBe('B');
    expect(merged.shape).toBe('s2');
  });

  it('returns next unchanged when lockedFields is empty / absent', () => {
    const current = { logline: 'a' };
    const next = { logline: 'A' };
    expect(planner.__testing.mergeArcWithLocks(current, next, {})).toEqual({ logline: 'A' });
    expect(planner.__testing.mergeArcWithLocks(current, next, null)).toEqual({ logline: 'A' });
    expect(planner.__testing.mergeArcWithLocks(current, next, undefined)).toEqual({ logline: 'A' });
  });

  it('passes next through when there is no current arc to preserve from', () => {
    const next = { logline: 'A' };
    expect(planner.__testing.mergeArcWithLocks(null, next, { logline: true })).toEqual({ logline: 'A' });
  });

  it('returns next when next is null/undefined (no-op)', () => {
    expect(planner.__testing.mergeArcWithLocks({ logline: 'a' }, null, { logline: true })).toBeNull();
    expect(planner.__testing.mergeArcWithLocks({ logline: 'a' }, undefined, { logline: true })).toBeUndefined();
  });

  it('ignores unknown lock keys (only ARC_LOCKABLE_FIELDS are honored)', () => {
    const current = { logline: 'a', summary: 'b' };
    const next = { logline: 'A', summary: 'B' };
    const merged = planner.__testing.mergeArcWithLocks(current, next, { logline: true, bogusKey: true });
    expect(merged.logline).toBe('a');
    expect(merged.summary).toBe('B');
    // bogusKey didn't survive into the merged shape.
    expect(merged.bogusKey).toBeUndefined();
  });
});

describe('arcPlanner — buildSeasonRemap', () => {
  it('matches by normalized title first', () => {
    const dropped = [{ id: 'old1', number: 1, title: 'The Velvet Pouch' }];
    const minted = [{ id: 'new1', number: 1, title: '  THE VELVET POUCH  ' }];
    const remap = planner.buildSeasonRemap(dropped, minted);
    expect(remap.get('old1')).toBe('new1');
  });

  it('falls back to unique number match', () => {
    const dropped = [{ id: 'old1', number: 2, title: 'Renamed' }];
    const minted = [
      { id: 'new1', number: 1, title: 'Different' },
      { id: 'new2', number: 2, title: 'Also Different' },
    ];
    const remap = planner.buildSeasonRemap(dropped, minted);
    expect(remap.get('old1')).toBe('new2');
  });

  it('pairs 2-old × 2-new entirely via unique-number when titles diverge but numbers match', () => {
    // Pre-tightening this case used to flow through Pass 3 (positional fallback);
    // now Pass 2 handles it because the numbers 1↔1 and 2↔2 are each unique.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped = [
      { id: 'old1', number: 1, title: 'A' },
      { id: 'old2', number: 2, title: 'B' },
    ];
    const minted = [
      { id: 'new1', number: 1, title: 'X' },
      { id: 'new2', number: 2, title: 'Y' },
    ];
    const remap = planner.buildSeasonRemap(dropped, minted);
    expect(remap.get('old1')).toBe('new1');
    expect(remap.get('old2')).toBe('new2');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('falls back positionally when exactly one unmatched on each side (forced 1↔1)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped = [{ id: 'old1', number: 1, title: 'A' }];
    const minted = [{ id: 'new1', number: 2, title: 'X' }];
    const remap = planner.buildSeasonRemap(dropped, minted);
    expect(remap.get('old1')).toBe('new1');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Pass 3 fired'),
    );
    warnSpy.mockRestore();
  });

  it('sanitizes multi-line / control-char titles in the Pass 3 warning to keep logging single-line', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped = [{ id: 'old1', number: 1, title: 'A\n\tWith newline' }];
    const minted = [{ id: 'new1', number: 2, title: '' }];
    planner.buildSeasonRemap(dropped, minted);
    const msg = warnSpy.mock.calls[0][0];
    expect(msg).not.toMatch(/\n/);
    expect(msg).toContain('A With newline');
    expect(msg).toContain('new1'); // empty title → falls back to id
    warnSpy.mockRestore();
  });

  it('strips C0/C1 control chars and full ANSI CSI sequences from titles before logging', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped = [{ id: 'old1', number: 1, title: 'Pre\x1b[31mEvil\x1b[0mSuffix\x07' }];
    const minted = [{ id: 'new1', number: 2, title: 'Clean\u0085Title' }]; // U+0085 = NEL (C1)
    planner.buildSeasonRemap(dropped, minted);
    const msg = warnSpy.mock.calls[0][0];
    expect(msg).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    // stripAnsi removes the full CSI sequences (ESC + '[31m' / ESC + '[0m'),
    // not just the ESC byte — so the '[31m' / '[0m' payload tails do NOT leak.
    expect(msg).toContain('PreEvilSuffix');
    expect(msg).not.toMatch(/\[31m|\[0m/);
    expect(msg).toContain('Clean Title');
    warnSpy.mockRestore();
  });

  it('drops orphans to null when 2+ unmatched on each side after pass 1/2', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Titles diverge AND numbers diverge → Pass 1 (title) and Pass 2 (unique
    // number) leave 2-old × 2-new unmatched. Old behavior would positionally
    // pair them; new behavior refuses and warns.
    const dropped = [
      { id: 'old1', number: 10, title: 'A' },
      { id: 'old2', number: 20, title: 'B' },
    ];
    const minted = [
      { id: 'new1', number: 1, title: 'X' },
      { id: 'new2', number: 2, title: 'Y' },
    ];
    const remap = planner.buildSeasonRemap(dropped, minted);
    expect(remap.get('old1')).toBeNull();
    expect(remap.get('old2')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('skipped positional fallback'),
    );
    warnSpy.mockRestore();
  });

  it('maps to null when nothing plausible exists', () => {
    const dropped = [{ id: 'old1', number: 1, title: 'A' }];
    const minted = [];
    const remap = planner.buildSeasonRemap(dropped, minted);
    expect(remap.get('old1')).toBeNull();
  });

  it('claims each minted season only once', () => {
    const dropped = [
      { id: 'old1', number: 1, title: 'Same' },
      { id: 'old2', number: 2, title: 'Same' },
    ];
    const minted = [
      { id: 'new1', number: 1, title: 'Same' },
    ];
    const remap = planner.buildSeasonRemap(dropped, minted);
    // First old gets the title match; second has no remaining mint.
    expect(remap.get('old1')).toBe('new1');
    expect(remap.get('old2')).toBeNull();
  });
});

describe('arcPlanner — generateComicCoverConcepts', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  async function setupIssue(stageOverrides = {}) {
    const s = await setupSeries();
    const issue = await issuesSvc.createIssue({
      seriesId: s.id,
      title: 'The Pilot',
      stages: {
        idea: { status: 'ready', input: 'A silent foundry mystery.', output: '- beat 1\n- beat 2' },
        prose: { status: 'ready', output: 'The bell tower lay quiet over the brackish quay…' },
        ...stageOverrides,
      },
    });
    return { series: s, issue };
  }

  it('feeds series + issue context (name, logline, styleNotes, idea.input/output, prose excerpt) into the prompt', async () => {
    const { issue } = await setupIssue();
    stageRunnerSpy = vi.fn(async () => ({
      content: { coverConcept: 'front concept', backCoverConcept: 'back concept' },
      runId: 'run-cv-1', providerId: 'claude', model: 'opus-4',
    }));

    const out = await planner.generateComicCoverConcepts(issue.id);

    expect(stageRunnerSpy).toHaveBeenCalledTimes(1);
    expect(stageRunnerSpy).toHaveBeenCalledWith(
      'pipeline-comic-cover-concepts',
      expect.objectContaining({
        series: expect.objectContaining({
          name: 'Salt Run',
          logline: 'A foundry city goes silent.',
          styleNotes: 'moebius linework',
        }),
        issue: expect.objectContaining({
          title: 'The Pilot',
          synopsis: 'A silent foundry mystery.',
          beats: '- beat 1\n- beat 2',
          proseExcerpt: 'The bell tower lay quiet over the brackish quay…',
        }),
      }),
      expect.objectContaining({ returnsJson: true, source: 'pipeline-comic-cover-concepts' }),
    );
    expect(out.coverConcept).toBe('front concept');
    expect(out.backCoverConcept).toBe('back concept');
    expect(out.target).toBe('both');
    // No commit ⇒ no seeding.
    expect(out.seeded).toEqual({ cover: false, backCover: false });
    expect(out.issue).toBeNull();
    expect(out.runId).toBe('run-cv-1');
  });

  it('caps very long prose at a 4000-char excerpt so the prompt budget stays bounded', async () => {
    const longProse = 'x'.repeat(5000);
    const { issue } = await setupIssue({
      prose: { status: 'ready', output: longProse },
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: { coverConcept: 'c', backCoverConcept: 'b' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    await planner.generateComicCoverConcepts(issue.id);

    const ctx = stageRunnerSpy.mock.calls[0][1];
    // 4000 chars of x + ellipsis truncation marker.
    expect(ctx.issue.proseExcerpt).toBe(`${'x'.repeat(4000)}…`);
    expect(ctx.issue.proseExcerpt.length).toBe(4001);
  });

  it('commit:true seeds BOTH cover + backCover scripts when slots are blank (target=both)', async () => {
    const { issue } = await setupIssue();
    stageRunnerSpy = vi.fn(async () => ({
      content: { coverConcept: 'front-seed', backCoverConcept: 'back-seed' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.generateComicCoverConcepts(issue.id, { commit: true });

    expect(out.seeded).toEqual({ cover: true, backCover: true });
    const stored = await issuesSvc.getIssue(issue.id);
    expect(stored.stages.comicPages.cover.script).toBe('front-seed');
    expect(stored.stages.comicPages.backCover.script).toBe('back-seed');
  });

  it('commit:true with target="cover" ONLY seeds the cover slot, even when LLM returns both', async () => {
    const { issue } = await setupIssue();
    stageRunnerSpy = vi.fn(async () => ({
      content: { coverConcept: 'front-seed', backCoverConcept: 'back-seed' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.generateComicCoverConcepts(issue.id, { commit: true, target: 'cover' });

    expect(out.seeded).toEqual({ cover: true, backCover: false });
    // Return shape still surfaces both concepts to the caller even though
    // only the targeted slot was seeded.
    expect(out.coverConcept).toBe('front-seed');
    expect(out.backCoverConcept).toBe('back-seed');
    const stored = await issuesSvc.getIssue(issue.id);
    expect(stored.stages.comicPages.cover.script).toBe('front-seed');
    expect(stored.stages.comicPages.backCover?.script || '').toBe('');
  });

  it('commit:true with target="backCover" ONLY seeds the backCover slot', async () => {
    const { issue } = await setupIssue();
    stageRunnerSpy = vi.fn(async () => ({
      content: { coverConcept: 'front-seed', backCoverConcept: 'back-seed' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.generateComicCoverConcepts(issue.id, { commit: true, target: 'backCover' });

    expect(out.seeded).toEqual({ cover: false, backCover: true });
    const stored = await issuesSvc.getIssue(issue.id);
    expect(stored.stages.comicPages.cover?.script || '').toBe('');
    expect(stored.stages.comicPages.backCover.script).toBe('back-seed');
  });

  it('commit:true does NOT overwrite non-empty cover.script (preserves user edits, even with target=both)', async () => {
    const { issue } = await setupIssue();
    // User-edited cover script in place before the LLM runs.
    await issuesSvc.updateStage(issue.id, 'comicPages', {
      cover: { script: 'USER WROTE THIS' },
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: { coverConcept: 'LLM front', backCoverConcept: 'LLM back' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.generateComicCoverConcepts(issue.id, { commit: true });

    // cover was occupied ⇒ skipped; backCover was blank ⇒ seeded.
    expect(out.seeded).toEqual({ cover: false, backCover: true });
    const stored = await issuesSvc.getIssue(issue.id);
    expect(stored.stages.comicPages.cover.script).toBe('USER WROTE THIS');
    expect(stored.stages.comicPages.backCover.script).toBe('LLM back');
  });

  it('commit:true does NOT overwrite non-empty backCover.script (preserves user edits)', async () => {
    const { issue } = await setupIssue();
    await issuesSvc.updateStage(issue.id, 'comicPages', {
      backCover: { script: 'USER BACK COVER' },
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: { coverConcept: 'LLM front', backCoverConcept: 'LLM back' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.generateComicCoverConcepts(issue.id, { commit: true });

    expect(out.seeded).toEqual({ cover: true, backCover: false });
    const stored = await issuesSvc.getIssue(issue.id);
    expect(stored.stages.comicPages.cover.script).toBe('LLM front');
    expect(stored.stages.comicPages.backCover.script).toBe('USER BACK COVER');
  });

  it('rejects an invalid target value', async () => {
    const { issue } = await setupIssue();
    await expect(
      planner.generateComicCoverConcepts(issue.id, { target: 'sideCover' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('Invalid target') });
    // LLM should never have been called for a validation failure.
    expect(stageRunnerSpy).toBeUndefined();
  });

  it('rejects an empty-string target (does not silently fall back to "both")', async () => {
    const { issue } = await setupIssue();
    await expect(
      planner.generateComicCoverConcepts(issue.id, { target: '' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('Invalid target') });
    expect(stageRunnerSpy).toBeUndefined();
  });

  it('treats a whitespace-only existing script as blank and seeds it (client/server parity)', async () => {
    // The client gate uses `.trim()` — the server must agree so a
    // " \n " script doesn't enable the button but skip seeding.
    const { issue } = await setupIssue();
    await issuesSvc.updateStage(issue.id, 'comicPages', {
      cover: { script: '   \n  ' },
      backCover: { script: '\t' },
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: { coverConcept: 'LLM front', backCoverConcept: 'LLM back' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.generateComicCoverConcepts(issue.id, { commit: true });

    expect(out.seeded).toEqual({ cover: true, backCover: true });
    const stored = await issuesSvc.getIssue(issue.id);
    expect(stored.stages.comicPages.cover.script).toBe('LLM front');
    expect(stored.stages.comicPages.backCover.script).toBe('LLM back');
  });
});

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

describe('arcPlanner — manuscript completeness + derive-from-manuscript', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
    stageContextSpy = undefined;
  });

  it('issueSynopsisFromSeason joins logline + synopsis (and is empty for nothing)', () => {
    const { issueSynopsisFromSeason } = planner.__testing;
    expect(issueSynopsisFromSeason({ logline: 'A', synopsis: 'B' })).toBe('A\n\nB');
    expect(issueSynopsisFromSeason({ logline: 'A', synopsis: '' })).toBe('A');
    expect(issueSynopsisFromSeason(null)).toBe('');
    expect(issueSynopsisFromSeason({})).toBe('');
  });

  it('shapeCompletenessFindings coerces category/severity and drops empty problems', () => {
    const { shapeCompletenessFindings } = planner.__testing;
    const out = shapeCompletenessFindings([
      { severity: 'high', category: 'missing-content', problem: 'no climax', suggestion: 'add one' },
      { severity: 'bogus', category: 'invented-category', problem: 'thin cast' },
      { problem: '   ' }, // dropped — empty after trim
      { category: 'pacing', problem: 'rushed' }, // default severity medium
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ severity: 'high', category: 'missing-content' });
    expect(out[1]).toMatchObject({ severity: 'medium', category: 'other' }); // both coerced
    expect(out[2]).toMatchObject({ severity: 'medium', category: 'pacing' });
  });

  it('analyzeManuscriptCompleteness reads the manuscript and returns shaped findings', async () => {
    const s = await setupSeries();
    await issuesSvc.createIssue({
      seriesId: s.id, title: 'Act 1', arcPosition: 1,
      stages: { comicScript: { output: 'PAGE 1\nGiant counts his gold.', status: 'ready' } },
    });
    stageRunnerSpy = vi.fn(async (template, ctx) => {
      // The pass must see the actual drafted script, not a synopsis.
      expect(template).toBe('pipeline-manuscript-completeness');
      expect(ctx.manuscript).toContain('Giant counts his gold');
      return {
        content: { issues: [{ severity: 'high', category: 'arc-gap', problem: 'no ending', suggestion: 'write one' }] },
        runId: 'rc', providerId: 'p', model: 'm',
      };
    });
    const out = await planner.analyzeManuscriptCompleteness(s.id);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0]).toMatchObject({ category: 'arc-gap', severity: 'high' });
    expect(out.chunked).toBe(false);
  });

  it('chunks a large manuscript that exceeds the model window and merges findings (first-wins dedupe + prior-findings digest)', async () => {
    const s = await setupSeries();
    const big = 'word '.repeat(12_000); // ~60k chars (~15k tokens) per issue
    await issuesSvc.createIssue({ seriesId: s.id, title: 'One', arcPosition: 1, stages: { prose: { output: `ONE ${big}`, status: 'ready' } } });
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Two', arcPosition: 2, stages: { prose: { output: `TWO ${big}`, status: 'ready' } } });
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Three', arcPosition: 3, stages: { prose: { output: `THREE ${big}`, status: 'ready' } } });
    stageContextSpy = vi.fn(async () => ({ provider: { id: 'p' }, model: 'm', contextWindow: 40_000 }));
    let n = 0;
    stageRunnerSpy = vi.fn(async () => {
      n += 1;
      return {
        content: { issues: [
          // same finding surfaced by every chunk — must be recorded once
          { severity: 'high', category: 'arc-gap', issueNumber: 1, anchorQuote: 'dup', problem: 'duplicated finding', suggestion: 'x' },
          { severity: 'low', category: 'pacing', problem: `unique ${n}`, suggestion: '' },
        ] },
        runId: `r${n}`, providerId: 'p', model: 'm',
      };
    });

    const out = await planner.analyzeManuscriptCompleteness(s.id);

    expect(out.chunked).toBe(true);
    expect(out.chunkCount).toBeGreaterThanOrEqual(2);
    expect(stageRunnerSpy).toHaveBeenCalledTimes(out.chunkCount);
    // duplicate finding collapsed to one; each chunk's unique finding kept
    expect(out.issues.filter((f) => f.anchorQuote === 'dup')).toHaveLength(1);
    expect(out.issues.filter((f) => f.problem.startsWith('unique'))).toHaveLength(out.chunkCount);
    // later chunks get a digest of earlier findings inside the manuscript field
    const secondManuscript = stageRunnerSpy.mock.calls[1][1].manuscript;
    expect(secondManuscript).toContain('already recorded for EARLIER chapters');
    expect(secondManuscript).toContain('duplicated finding');
  });

  it('analyzeManuscriptCompleteness refuses when no manuscript exists', async () => {
    const s = await setupSeries();
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Empty', arcPosition: 1 });
    await expect(planner.analyzeManuscriptCompleteness(s.id)).rejects.toMatchObject({ code: 'PIPELINE_ARC_VALIDATION' });
  });

  it('analyzeManuscriptCompleteness treats an idea-only issue as no manuscript (outline is not a draft)', async () => {
    const s = await setupSeries();
    // Only an idea/synopsis seed — no drafted comicScript/prose/teleplay.
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Outline only', arcPosition: 1, stages: { idea: { input: 'a synopsis', status: 'edited' } } });
    await expect(planner.analyzeManuscriptCompleteness(s.id)).rejects.toMatchObject({ code: 'PIPELINE_ARC_VALIDATION' });
  });

  it('analyzeManuscriptCompleteness carries issueNumber + anchorQuote and tolerates their absence', async () => {
    const s = await setupSeries();
    await issuesSvc.createIssue({ seriesId: s.id, title: 'One', arcPosition: 1, stages: { prose: { output: 'A short draft.', status: 'ready' } } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { issues: [
        { severity: 'high', category: 'arc-gap', issueNumber: 1, anchorQuote: '  a quote  ', problem: 'anchored', suggestion: 'fix it' },
        { severity: 'low', category: 'pacing', problem: 'unanchored', suggestion: '' },
      ] },
      runId: 'rc', providerId: 'p', model: 'm',
    }));
    const out = await planner.analyzeManuscriptCompleteness(s.id);
    expect(out.issues[0]).toMatchObject({ issueNumber: 1, anchorQuote: 'a quote' });
    expect(out.issues[1]).toMatchObject({ issueNumber: null, anchorQuote: '' });
  });

  it('collectManuscriptSections orders by arcPosition, drops empties, and collectIssueSourceText stays byte-identical', async () => {
    const s = await setupSeries();
    // Insert out of arcPosition order to prove sorting (don't assert on the
    // auto-assigned `number`, which follows creation order, not arcPosition).
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Two', arcPosition: 2, stages: { teleplay: { output: 'TELE two', status: 'ready' } } });
    await issuesSvc.createIssue({ seriesId: s.id, title: 'One', arcPosition: 1, stages: { comicScript: { output: 'PAGE 1\none', status: 'ready' } } });
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Empty', arcPosition: 3 });

    const sections = await planner.collectManuscriptSections(s.id);
    // Empty issue dropped; remaining two ordered by arcPosition (One before Two).
    expect(sections.map((x) => x.content)).toEqual(['PAGE 1\none', 'TELE two']);
    expect(sections.map((x) => x.stageId)).toEqual(['comicScript', 'teleplay']);
    expect(sections.map((x) => x.title)).toEqual(['One', 'Two']);
    expect(planner.primaryStageIdOf(sections)).toBeDefined();

    // The corpus join derives from the sections — verify the invariant.
    const corpus = await planner.collectIssueSourceText(s.id, { stageOrder: planner.MANUSCRIPT_STAGES });
    const expected = sections
      .map((x) => `# Issue ${x.number} — ${x.title} (${x.stageId})\n\n${x.content}`)
      .join('\n\n---\n\n');
    expect(corpus).toBe(expected);
  });

  it('deriveFromManuscript proposes a single volume + bible + zipped issue synopses', async () => {
    const s = await setupSeries();
    const sea = await seasonsSvc.createSeason(s.id, { title: 'V1', episodeCountTarget: 3 });
    await issuesSvc.createIssue({ seriesId: s.id, seasonId: sea.id, title: 'Issue 1', arcPosition: 1, stages: { comicScript: { output: 'PAGE 1\nopening', status: 'ready' } } });
    await issuesSvc.createIssue({ seriesId: s.id, seasonId: sea.id, title: 'Issue 2', arcPosition: 2, stages: { comicScript: { output: 'PAGE 1\nmiddle', status: 'ready' } } });

    stageRunnerSpy = vi.fn(async (template) => {
      expect(template).toBe('importer-arc-extract');
      return {
        content: {
          logline: 'A giant hoards gold.', summary: 'A fairy-tale retold.', themes: ['greed'], protagonistArc: 'arc', shape: null,
          seasons: [
            { number: 1, title: 'The Miracle Man', logline: 'Beanstalk begins', synopsis: 'syn1' },
            { number: 2, title: 'Magic Beans', logline: 'The climb', synopsis: 'syn2' },
          ],
        },
        runId: 'rd', providerId: 'p', model: 'm',
      };
    });

    const out = await planner.deriveFromManuscript(s.id);
    expect(out.bible).toMatchObject({ logline: 'A giant hoards gold.', premise: 'A fairy-tale retold.', issueCountTarget: 2 });
    expect(out.volume.title).toBe('Salt Run'); // defaults to series name
    expect(out.issues).toHaveLength(2);
    expect(out.issues[0].synopsisSuggestion).toContain('Beanstalk begins');
    expect(out.issues[1].synopsisSuggestion).toContain('The climb');
  });

  it('commitDerivedManuscript collapses to one volume, pins all issues, fills bible, seeds synopses, leaves scripts intact', async () => {
    const s = await setupSeries({ logline: '', premise: '', issueCountTarget: 0 });
    const v1 = await seasonsSvc.createSeason(s.id, { title: 'V1', episodeCountTarget: 1 });
    const v2 = await seasonsSvc.createSeason(s.id, { title: 'V2', episodeCountTarget: 1 });
    const v3 = await seasonsSvc.createSeason(s.id, { title: 'V3', episodeCountTarget: 1 });
    const v4 = await seasonsSvc.createSeason(s.id, { title: 'V4', episodeCountTarget: 1 });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v1.id, title: 'Issue 1', arcPosition: 1, stages: { comicScript: { output: 'PAGE 1\nverbatim one', status: 'ready' } } });
    const i2 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v2.id, title: 'Issue 2', arcPosition: 2, stages: { comicScript: { output: 'PAGE 1\nverbatim two', status: 'ready' } } });
    const i3 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v3.id, title: 'Issue 3', arcPosition: 3, stages: { comicScript: { output: 'PAGE 1\nverbatim three', status: 'ready' } } });

    const out = await planner.commitDerivedManuscript(s.id, {
      arc: { logline: 'LG', summary: 'SM', themes: ['t'], protagonistArc: 'PA', shape: null },
      bible: { logline: 'LG', premise: 'SM', issueCountTarget: 3 },
      volume: { title: 'The Giant', logline: 'vlog', synopsis: 'vsyn' },
      issues: [
        { id: i1.id, title: 'Act One', synopsis: 'act one synopsis' },
        { id: i2.id, title: 'Act Two', synopsis: 'act two synopsis' },
        { id: i3.id, synopsis: 'act three synopsis' },
      ],
    });

    // Exactly one volume survives.
    expect(out.series.seasons).toHaveLength(1);
    const vol = out.series.seasons[0];
    expect(vol.title).toBe('The Giant');
    // Bible filled.
    expect(out.series).toMatchObject({ logline: 'LG', premise: 'SM', issueCountTarget: 3 });

    // Every issue is under the single volume.
    const all = await issuesSvc.listIssues({ seriesId: s.id });
    expect(all.every((iss) => iss.seasonId === vol.id)).toBe(true);

    // Per-issue title + synopsis applied; verbatim comicScript untouched.
    const f1 = await issuesSvc.getIssue(i1.id);
    expect(f1.title).toBe('Act One');
    expect(f1.stages.idea.input).toBe('act one synopsis');
    expect(f1.stages.comicScript.output).toBe('PAGE 1\nverbatim one');
    const f3 = await issuesSvc.getIssue(i3.id);
    expect(f3.stages.idea.input).toBe('act three synopsis');
    void v4;
  });

  it('commitDerivedManuscript respects a locked idea stage (does not overwrite synopsis)', async () => {
    const s = await setupSeries();
    const v1 = await seasonsSvc.createSeason(s.id, { title: 'V1' });
    const i1 = await issuesSvc.createIssue({
      seriesId: s.id, seasonId: v1.id, title: 'Issue 1', arcPosition: 1,
      stages: { comicScript: { output: 'PAGE 1\nx', status: 'ready' }, idea: { input: 'frozen synopsis', status: 'edited', locked: true } },
    });
    await planner.commitDerivedManuscript(s.id, {
      arc: { logline: 'L', summary: 'S' },
      bible: { logline: 'L', premise: 'S', issueCountTarget: 1 },
      volume: { title: 'Vol' },
      issues: [{ id: i1.id, synopsis: 'should not apply' }],
    });
    const f1 = await issuesSvc.getIssue(i1.id);
    expect(f1.stages.idea.input).toBe('frozen synopsis');
  });

  it('commitDerivedManuscript does not strip issues out of a locked non-kept volume', async () => {
    const s = await setupSeries();
    const v1 = await seasonsSvc.createSeason(s.id, { title: 'V1', number: 1 });
    const v2 = await seasonsSvc.createSeason(s.id, { title: 'V2 (locked)', number: 2 });
    await seasonsSvc.updateSeason(s.id, v2.id, { locked: true });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v1.id, title: 'Issue 1', arcPosition: 1, stages: { comicScript: { output: 'PAGE 1\nx', status: 'ready' } } });
    const iLocked = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v2.id, title: 'Locked vol issue', arcPosition: 2, stages: { comicScript: { output: 'PAGE 1\ny', status: 'ready' } } });

    const out = await planner.commitDerivedManuscript(s.id, {
      arc: { logline: 'L', summary: 'S' },
      bible: { logline: 'L', premise: 'S', issueCountTarget: 2 },
      volume: { title: 'The Giant' },
      issues: [{ id: i1.id, synopsis: 'a' }, { id: iLocked.id, synopsis: 'b' }],
    });

    // The locked volume survives (commitSeasonsWithRemap re-inserts it) — so we
    // did NOT collapse to a single volume, and its issue must stay put.
    const seasonIds = out.series.seasons.map((x) => x.id);
    expect(seasonIds).toContain(v2.id);
    const fLocked = await issuesSvc.getIssue(iLocked.id);
    expect(fLocked.seasonId).toBe(v2.id); // not stripped onto the target volume
    const f1 = await issuesSvc.getIssue(i1.id);
    expect(f1.seasonId).toBe(v1.id); // the kept (lowest, unlocked) volume reused its id
  });
});
