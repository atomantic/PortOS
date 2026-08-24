import { readFileSync } from 'fs';
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
vi.mock('../stageRunner.js', () => ({
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
    const s = await setupSeries({
      universeId: world.id,
      premise: 'Mira Holt must recover The Tongue before the foundry city goes silent.',
    });

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

  it('excludes abandoned-draft canon that the protected premise and active cast never reference', async () => {
    const world = await worldSvc.createUniverse({
      name: 'Example World',
      starterPrompt: 'Asha Reed follows a signal through the Glass Harbor.',
      characters: [
        { id: 'char-active', name: 'Asha Reed', role: 'lead', relationships: 'Trusts Fen.' },
        { id: 'char-support', name: 'Fen', role: 'scout' },
        { id: 'char-stale', name: 'Director Voss', role: 'antagonist' },
      ],
      places: [
        { id: 'place-active', name: 'Glass Harbor', description: 'a flooded observatory' },
        { id: 'place-stale', name: 'Central Ministry', description: 'an old-draft headquarters' },
      ],
      objects: [
        { id: 'obj-stale', name: 'Compliance Seal', description: 'an old-draft badge' },
      ],
    });
    const s = await setupSeries({
      universeId: world.id,
      premise: 'Asha Reed and Fen trace the Glass Harbor signal.',
      characterArcs: [{ characterId: 'char-active', characterName: 'Asha Reed', startState: 'alone', endState: 'trusting' }],
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'L', summary: 'S', themes: [], protagonistArc: 'A', seasonOutlines: [] },
      runId: 'r1', providerId: 'p', model: 'm',
    }));

    await planner.generateArcOverview(s.id);

    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.worldCanonText).toContain('Asha Reed');
    expect(ctx.worldCanonText).toContain('Fen');
    expect(ctx.worldCanonText).toContain('Glass Harbor');
    expect(ctx.worldCanonText).not.toContain('Director Voss');
    expect(ctx.worldCanonText).not.toContain('Central Ministry');
    expect(ctx.worldCanonText).not.toContain('Compliance Seal');
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

  it('keeps generated episode synopses within the shared planning budget at a clause boundary', async () => {
    const { series, seasons } = await setupSeriesWithSeasons();
    const overlong = `${'A consequential setup. '.repeat(220)}This tail must be removed`;
    stageRunnerSpy = vi.fn(async () => ({
      content: { episodes: [{ number: 1, title: 'Budgeted', synopsis: overlong, arcRole: 'pilot' }] },
      runId: 'r1', providerId: 'p', model: 'm',
    }));

    const out = await planner.generateSeasonEpisodes(series.id, seasons[0].id);
    expect(out.episodes[0].synopsis.length).toBeLessThanOrEqual(4_000);
    expect(out.episodes[0].synopsis).toMatch(/[.!?]$/);
    expect(out.episodes[0].synopsis).not.toContain('This tail must be removed');
  });

  it('keeps generated episode loglines within their budget at a word boundary', async () => {
    const { series, seasons } = await setupSeriesWithSeasons();
    const overlong = `${'A consequential choice changes the pursuit without ending it. '.repeat(12)}consequence`;
    stageRunnerSpy = vi.fn(async () => ({
      content: { episodes: [{ number: 1, title: 'Budgeted', logline: overlong, arcRole: 'pilot' }] },
      runId: 'r1', providerId: 'p', model: 'm',
    }));

    const out = await planner.generateSeasonEpisodes(series.id, seasons[0].id);
    expect(out.episodes[0].logline.length).toBeLessThanOrEqual(500);
    expect(overlong.split(' ')).toContain(out.episodes[0].logline.split(' ').pop());
    expect(out.episodes[0].logline).not.toMatch(/conseque$/);
  });

  it('rejects the `custom` length sentinel and derives distinct climax/finale fallbacks', async () => {
    const { series, seasons } = await setupSeriesWithSeasons();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        episodes: [
          // LLM emitted `custom` without page/minute companions → reject sentinel,
          // fall back via arcRole. arcRole=finale → finale preset.
          { number: 1, title: 'Finale', arcRole: 'finale', lengthProfile: 'custom' },
          // Climax independently defaults to extended rather than borrowing
          // the later finale's full-runtime profile.
          { number: 4, title: 'Climax', arcRole: 'climax', lengthProfile: 'custom' },
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
    expect(byTitle.Climax.lengthProfile).toBe('extended');
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

  it('reuses an exact set of empty ungrouped placeholders when Autopilot requests it', async () => {
    const s = await setupSeries();
    const first = await issuesSvc.createIssue({
      seriesId: s.id,
      title: 'Placeholder A',
      stages: {
        idea: {
          status: 'empty',
          input: '',
          output: '',
          lastRunId: 'run-rejected',
          runHistory: [{ runId: 'run-archived', createdAt: '2026-01-01T00:00:00.000Z', input: 'Old plan', output: '' }],
        },
      },
    });
    const second = await issuesSvc.createIssue({
      seriesId: s.id,
      title: 'Placeholder B',
      stages: { comicPages: { status: 'ready', pages: [{ pageNumber: 1, panels: [] }] } },
    });
    const episodes = [
      { number: 1, title: 'Opening', arcRole: 'pilot', logline: 'L1', synopsis: 'S1', lengthProfile: 'standard' },
      { number: 2, title: 'Turn', arcRole: 'complication', logline: 'L2', synopsis: 'S2', lengthProfile: 'short' },
    ];

    const reused = await planner.commitEpisodesToIssues(s.id, 'sea-example', episodes, { reuseUngrouped: true });

    expect(reused.map((issue) => issue.id)).toEqual([first.id, second.id]);
    expect(reused.map((issue) => issue.title)).toEqual(['Opening', 'Turn']);
    expect(reused.every((issue) => issue.seasonId === 'sea-example')).toBe(true);
    expect(reused[0].stages.idea.lastRunId).toBeNull();
    expect(reused[0].stages.idea.runHistory).toHaveLength(1);
    expect(reused[0].stages.idea.runHistory[0].runId).toBe('run-archived');
    expect(reused[1].stages.comicPages.pages).toHaveLength(1);
    expect(await issuesSvc.listIssues({ seriesId: s.id })).toHaveLength(2);
  });

  it('refuses to duplicate or partially reuse placeholders when their count differs from the episode plan', async () => {
    const s = await setupSeries();
    const placeholder = await issuesSvc.createIssue({ seriesId: s.id, title: 'Placeholder' });
    const episodes = [
      { number: 1, title: 'One', logline: 'L1', synopsis: 'S1' },
      { number: 2, title: 'Two', logline: 'L2', synopsis: 'S2' },
    ];

    await expect(planner.commitEpisodesToIssues(s.id, null, episodes, { reuseUngrouped: true }))
      .rejects.toMatchObject({ code: planner.ERR_VALIDATION });
    expect((await issuesSvc.listIssues({ seriesId: s.id })).map((issue) => issue.id)).toEqual([placeholder.id]);
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

  // The verify prompt's arc-role imbalance check (#6) can only see what this
  // leaf renders. While `arcRole` was missing from it, a volume with a correct
  // pilot and finale still reported "zero pilot/finale" on every pass — and
  // because the foundation gate's structure arm reverts whenever verifyArc
  // leaves any blocker, that permanent false positive stalled the gate.
  it('renders climax and later finale roles with independent length profiles', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L', summary: 'S' } });
    const sea = await seasonsSvc.createSeason(s.id, { title: 'V1' });
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Ep 1', seasonId: sea.id, arcPosition: 1, arcRole: 'pilot' });
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Ep 2', seasonId: sea.id, arcPosition: 2 });
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Ep 3', seasonId: sea.id, arcPosition: 3, arcRole: 'climax', lengthProfile: 'extended' });
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Ep 4', seasonId: sea.id, arcPosition: 4, arcRole: 'finale', lengthProfile: 'finale' });

    stageRunnerSpy = vi.fn(async () => ({ content: { issues: [] }, runId: 'r1', providerId: 'p', model: 'm' }));
    await planner.verifyArc(s.id);

    const tree = JSON.parse(stageRunnerSpy.mock.calls[0][1].seasonsTreeJson);
    // null (not absent) for the middle episode — "no role" has to be legible as
    // a value, or the check can't tell an unset role from a dropped field.
    expect(tree[0].episodes.map((e) => e.arcRole)).toEqual(['pilot', null, 'climax', 'finale']);
    expect(tree[0].episodes.map((e) => e.lengthProfile)).toEqual(['standard', 'standard', 'extended', 'finale']);
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

  it('can force synopsis-only verification for the pre-beat autopilot planning gate', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'Whole arc' } });
    const sea = await seasonsSvc.createSeason(s.id, { title: 'V1', logline: 'volume' });
    await issuesSvc.createIssue({
      seriesId: s.id,
      title: 'Ep 1',
      seasonId: sea.id,
      stages: { idea: { input: 'synopsis seed', output: 'existing beat sheet', status: 'ready' } },
    });
    stageRunnerSpy = vi.fn(async () => ({ content: { issues: [] }, runId: 'r', providerId: 'p', model: 'm' }));

    await planner.verifyVolume(s.id, sea.id, { synopsisOnly: true });

    const [volumeIssue] = JSON.parse(stageRunnerSpy.mock.calls[0][1].volumeIssuesJson);
    expect(volumeIssue.synopsis).toBe('synopsis seed');
    expect(volumeIssue).not.toHaveProperty('beats');
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

  it('applies exact long-text edits without accepting a wholesale synopsis rewrite', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, {
      arc: {
        logline: 'old logline',
        summary: 'Opening stays. The route opens before consent. Finale stays.',
        protagonistArc: 'They begin afraid. They end accountable.',
      },
    });
    const existingSeason = await seasonsSvc.createSeason(s.id, {
      title: 'Season 1',
      synopsis: 'Issue one stays. Ledger D opens before the vote. Issue three stays.',
      endingHook: 'The old charter remains active.',
      episodeCountTarget: 3,
    });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        arc: {
          resolves: ['f1'],
          summary: 'WHOLESALE ARC REWRITE MUST BE IGNORED',
          summaryEdits: [{
            find: 'The route opens before consent.',
            replace: 'The route opens only after affected delegates consent.',
          }],
        },
        seasons: [{
          resolves: ['f1'],
          id: existingSeason.id,
          synopsis: 'WHOLESALE VOLUME REWRITE MUST BE IGNORED',
          synopsisEdits: [{
            find: 'Ledger D opens before the vote.',
            replace: 'Ledger D remains dark until the vote passes.',
          }],
          endingHookEdits: [{
            find: 'The old charter remains active.',
            replace: 'The old charter lapses when the crossing begins.',
          }],
        }],
        notes: '',
      },
      runId: 'r1', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'The crossing precedes consent.', suggestion: 'Move consent first.' }],
    });

    expect(out.series.arc.summary).toBe(
      'Opening stays. The route opens only after affected delegates consent. Finale stays.',
    );
    expect(out.series.arc.protagonistArc).toBe('They begin afraid. They end accountable.');
    expect(out.series.seasons[0].synopsis).toBe(
      'Issue one stays. Ledger D remains dark until the vote passes. Issue three stays.',
    );
    expect(out.series.seasons[0].endingHook).toBe(
      'The old charter lapses when the crossing begins.',
    );
    const budgets = JSON.parse(stageRunnerSpy.mock.calls[0][1].textBudgetsJson);
    expect(budgets.seasons[0].endingHook).toEqual({
      current: 'The old charter remains active.'.length,
      max: 1000,
      remaining: 1000 - 'The old charter remains active.'.length,
    });
  });

  // Transition labels cap at 200 and the sanitizer CLIPS an overrun instead of
  // rejecting it, so a resolver writing blind lands a half-clause milestone that
  // the next spine round reports as an incomplete record — the budget block is
  // what tells it the cap it is actually measured against.
  it('publishes per-transition character-arc budgets to the resolve prompt', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'seed', summary: 'The queue claim changes hands.', status: 'draft' },
      characterArcs: [{
        characterId: 'chr-11111111-2222-3333-4444-555555555555',
        characterName: 'Queue broker',
        want: 'To keep the queue claim.',
        transitions: [{
          id: 'trn-11111111-2222-3333-4444-555555555555',
          kind: 'point-of-no-return',
          atIssue: 14,
          label: 'Escrows the proceeds with no lien.',
          note: 'The queue claim passes to the coalition.',
        }],
      }],
    });

    stageRunnerSpy = vi.fn(async () => ({
      content: { notes: '' }, runId: 'r1', providerId: 'p', model: 'm',
    }));
    await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'medium', problem: 'milestone is incomplete', suggestion: 'complete it' }],
    });

    const budgets = JSON.parse(stageRunnerSpy.mock.calls[0][1].textBudgetsJson);
    expect(budgets.characterArcs).toHaveLength(1);
    const [arcBudget] = budgets.characterArcs;
    expect(arcBudget.characterId).toBe('chr-11111111-2222-3333-4444-555555555555');
    expect(arcBudget.want).toEqual({
      current: 'To keep the queue claim.'.length,
      max: 1000,
      remaining: 1000 - 'To keep the queue claim.'.length,
    });
    expect(arcBudget.transitions[0]).toEqual({
      id: 'trn-11111111-2222-3333-4444-555555555555',
      atIssue: 14,
      label: {
        current: 'Escrows the proceeds with no lien.'.length,
        max: 200,
        remaining: 200 - 'Escrows the proceeds with no lien.'.length,
      },
      note: {
        current: 'The queue claim passes to the coalition.'.length,
        max: 1000,
        remaining: 1000 - 'The queue claim passes to the coalition.'.length,
      },
    });
  });

  it('rejects ambiguous, whole-field, and over-limit exact text edits', () => {
    expect(planner.applyExactTextEdits(
      'repeat here; repeat here',
      [{ find: 'repeat here', replace: 'changed' }],
      100,
    )).toEqual({ value: 'repeat here; repeat here', applied: 0, rejected: 1 });

    expect(planner.applyExactTextEdits(
      'the complete field',
      [{ find: 'the complete field', replace: 'wholesale replacement' }],
      8000,
    )).toEqual({ value: 'the complete field', applied: 0, rejected: 1 });

    expect(planner.applyExactTextEdits(
      'short anchor',
      [{ find: 'anchor', replace: 'a replacement that exceeds the cap' }],
      20,
    )).toEqual({ value: 'short anchor', applied: 0, rejected: 1 });
  });

  it('reports an over-limit exact-only response as not applied', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const originalHook = `${'x'.repeat(980)} target`;
    const season = await seasonsSvc.createSeason(s.id, {
      number: 1,
      title: 'Vol 1',
      synopsis: 'The volume remains unchanged.',
      endingHook: originalHook,
      episodeCountTarget: 1,
    });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        seasons: [{
          resolves: ['f1'],
          id: season.id,
          endingHookEdits: [{
            find: 'target',
            replace: 'a much longer replacement that cannot fit inside the field cap',
          }],
        }],
      },
      runId: 'r-over-limit', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'medium', problem: 'Fix the hook.', suggestion: 'Use the right legal state.' }],
    });

    expect(out.applied).toBe(false);
    expect(out.rejectedExactEdits).toBe(1);
    expect(out.series.seasons[0].endingHook).toBe(originalHook);
    // Categorical, so the stall diagnosis can tell a patch whose anchors no
    // longer match from a resolver that declined to propose anything.
    expect(out.noChangeReason).toBe('exact-edits-rejected');
    expect(out.mutations).toEqual({ arcFieldsEdited: 0, volumesEdited: 0, characterArcsEdited: 0, episodesEdited: 0 });
  });

  it('counts what a spine-scope resolve wrote, per record kind (#3843)', async () => {
    // An arc-spine resolver may not touch episodes at all, so `episodesEdited`
    // is 0 on every one of its rounds — the gate reported that alone and a
    // round that rewrote the arc and two volumes read as a no-op.
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'old logline', summary: 'old summary' } });
    const v1 = await seasonsSvc.createSeason(s.id, { number: 1, title: 'Vol 1', synopsis: 'v1 old', episodeCountTarget: 3 });
    const v2 = await seasonsSvc.createSeason(s.id, { number: 2, title: 'Vol 2', synopsis: 'v2 old', episodeCountTarget: 3 });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { resolves: ['f1'], logline: 'old logline', summary: 'new summary' },
        seasons: [
          { resolves: ['f1'], id: v1.id, synopsis: 'v1 new' },
          { resolves: ['f1'], id: v2.id, synopsis: 'v2 new' },
        ],
        notes: '',
      },
      runId: 'r-spine', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      spineOnly: true,
      findings: [{ id: 'f1', severity: 'high', problem: 'the vow is never paid off', suggestion: 'pay it off in V2' }],
    });

    expect(out.applied).toBe(true);
    // One arc field moved (`summary`); `logline` came back identical and is not
    // counted as a rewrite.
    expect(out.mutations).toEqual({ arcFieldsEdited: 1, volumesEdited: 2, characterArcsEdited: 0, episodesEdited: 0 });
    expect(out.noChangeReason).toBeNull();
  });

  it('names the reason when a spine resolve answers with episode edits it may not apply (#3843)', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const v1 = await seasonsSvc.createSeason(s.id, { number: 1, title: 'Vol 1', episodeCountTarget: 1 });
    await issuesSvc.createIssue({ seriesId: s.id, seasonId: v1.id, title: 'Pilot' });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        episodes: [{ resolves: ['f1'], seasonNumber: 1, episodeNumber: 1, synopsis: 'a rewritten synopsis' }],
        notes: '',
      },
      runId: 'r-out-of-scope', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      spineOnly: true,
      findings: [{ id: 'f1', severity: 'high', problem: 'the pilot contradicts the volume', suggestion: 'fix it' }],
    });

    expect(out.applied).toBe(false);
    // Not "the resolver did nothing" — it answered at an altitude this gate
    // forbids, which is a different defect with a different fix.
    expect(out.noChangeReason).toBe('edits-out-of-scope');
  });

  it('documents every no-change reason in the prompts that are handed one (#3843)', () => {
    // The reasons only earn their keep if the diagnosis can read them. A value
    // the legend never explains reaches the model as an unglossed token, which
    // is the misreading this telemetry exists to end.
    const legends = ['pipeline-observer.md', 'pipeline-self-improve.md'].map((file) => readFileSync(
      new URL(`../../../data.reference/prompts/stages/${file}`, import.meta.url),
      'utf8',
    ));
    for (const reason of planner.RESOLVE_NO_CHANGE_REASONS) {
      for (const legend of legends) expect(legend).toContain(`\`${reason}\``);
    }
  });

  it('reports a resolver that proposed nothing at all as a content-level refusal (#3843)', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { notes: 'I cannot resolve this without inventing canon.' },
      runId: 'r-refusal', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ id: 'f1', severity: 'high', problem: 'the vow is never paid off', suggestion: 'pay it off' }],
    });

    expect(out.applied).toBe(false);
    expect(out.noChangeReason).toBe('no-edits-returned');
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

  it('rewrites title-matched seasons in place when the LLM omits their ids', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const oldS1 = await seasonsSvc.createSeason(s.id, { title: 'The Velvet Pouch', episodeCountTarget: 3 });
    const oldS2 = await seasonsSvc.createSeason(s.id, { title: 'Six Blocks Down', episodeCountTarget: 3 });
    const oldS3 = await seasonsSvc.createSeason(s.id, { title: 'The City Looks Back', episodeCountTarget: 3 });

    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS1.id, title: 'Pilot' });
    const i2 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS2.id, title: 'Middle' });
    const i3 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS3.id, title: 'Finale' });

    // LLM returns seasons by title without preserving ids. These are rewrites
    // of the existing volumes, not new ones — `matchProposedSeasons` must land
    // them on the existing records rather than minting title-alike siblings.
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
    // Rewritten in place — no mint, so nothing to remap and no duplicate
    // "Volume 1" left behind.
    expect([newS1.id, newS2.id, newS3.id]).toEqual([oldS1.id, oldS2.id, oldS3.id]);

    const finalI1 = await issuesSvc.getIssue(i1.id);
    const finalI2 = await issuesSvc.getIssue(i2.id);
    const finalI3 = await issuesSvc.getIssue(i3.id);
    expect(finalI1.seasonId).toBe(newS1.id);
    expect(finalI2.seasonId).toBe(newS2.id);
    expect(finalI3.seasonId).toBe(newS3.id);
  });

  it('does not mint a duplicate volume across repeated unlock-for-run resolves', async () => {
    // The divergence regression: the autopilot's unlock-for-run mode passes
    // `preserveDroppedSeasons`, so a minted look-alike volume gets the original
    // re-inserted next to it. Two rounds used to leave three Volume 1 records —
    // a blocking arc-verify finding that no further round could clear.
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const v1 = await seasonsSvc.createSeason(s.id, { number: 1, title: 'Salt at the Root', episodeCountTarget: 12 });
    const ep = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v1.id, title: 'Ep 1' });

    let round = 0;
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        // Same volume, rewritten synopsis, id omitted — verbatim the shape the
        // resolve prompt returns.
        seasons: [{ number: 1, title: 'Salt at the Root', synopsis: `revision ${++round}`, endingHook: '', episodeCountTarget: 12 }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    for (let i = 0; i < 2; i += 1) {
      await planner.resolveVerifyIssues(s.id, {
        findings: [{ severity: 'high', problem: 'X', suggestion: 'Y' }],
        preserveDroppedSeasons: true,
      });
    }

    const after = await seriesSvc.getSeries(s.id);
    expect(after.seasons).toHaveLength(1);
    expect(after.seasons[0].id).toBe(v1.id);
    expect(after.seasons[0].synopsis).toBe('revision 2'); // the rewrite still applied
    expect((await issuesSvc.getIssue(ep.id)).seasonId).toBe(v1.id);
  });

  it('treats an empty seasons[] as a no-op, not a volume wipe (#3724 sparse patch)', async () => {
    // `seasons[]` is a SPARSE patch list: a resolve round that edits nothing at
    // the volume level leaves the lineup — and every episode under it — alone.
    // Before #3724 this same response deleted the only volume and dropped its
    // issue into the ungrouped bucket.
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const oldS = await seasonsSvc.createSeason(s.id, { title: 'Only Season', episodeCountTarget: 3 });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS.id, title: 'Orphan' });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { resolves: ['f1'], logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        seasons: [],
        notes: 'recommend collapsing Only Season — not doing it here',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'medium', problem: 'X', suggestion: 'Y' }],
    });

    expect(out.series.arc.logline).toBe('L2'); // the targeted arc edit still lands
    expect(out.series.seasons.map((x) => x.id)).toEqual([oldS.id]);
    expect((await issuesSvc.getIssue(i1.id)).seasonId).toBe(oldS.id);
  });

  it('leaves volumes the response omits exactly as they are', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const v1 = await seasonsSvc.createSeason(s.id, { number: 1, title: 'Vol 1', synopsis: 'v1 original', episodeCountTarget: 3 });
    const v2 = await seasonsSvc.createSeason(s.id, { number: 2, title: 'Vol 2', synopsis: 'v2 original', episodeCountTarget: 3 });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { resolves: ['f1'], logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        // Only volume 2 was edited — volume 1 isn't in the response at all.
        seasons: [{ resolves: ['f1'], id: v2.id, number: 2, title: 'Vol 2', synopsis: 'v2 rewritten' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'volume 2 drops the mentor', suggestion: 'pay it off' }],
    });

    expect(out.series.seasons.map((x) => x.id)).toEqual([v1.id, v2.id]);
    expect(out.series.seasons[0].synopsis).toBe('v1 original'); // untouched
    expect(out.series.seasons[1].synopsis).toBe('v2 rewritten');
  });

  it('applies sparse character-arc and transition patches without replacing IDs or sibling arcs', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'L' },
      characterArcs: [
        {
          characterId: 'chr-lead', characterName: 'Lead', want: 'escape', need: 'trust',
          startState: 'guarded', endState: 'open', status: 'verified',
          transitions: [
            { id: 'trn-choice', kind: 'decision', atIssue: 5, label: 'withholds consent', note: 'old note' },
            { id: 'trn-sacrifice', kind: 'sacrifice', atIssue: 11, label: 'spends the reserve', note: '' },
          ],
        },
        {
          characterId: 'chr-sibling', characterName: 'Sibling', want: 'belong', need: 'choose',
          startState: 'adrift', endState: 'committed', transitions: [],
        },
      ],
    });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        characterArcs: [{
          resolves: ['f1'],
          characterId: 'chr-lead',
          transitions: [{ id: 'trn-sacrifice', atIssue: 12, label: 'freely authorizes the final opening' }],
        }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'The sacrifice is assigned to issue 11.', suggestion: 'Move it to 12.' }],
      spineOnly: true,
    });

    expect(out.series.characterArcs).toHaveLength(2);
    const [lead, sibling] = out.series.characterArcs;
    expect(lead).toMatchObject({ characterId: 'chr-lead', want: 'escape', need: 'trust', status: 'verified' });
    expect(lead.transitions).toEqual([
      expect.objectContaining({ id: 'trn-choice', atIssue: 5, label: 'withholds consent', note: 'old note' }),
      expect.objectContaining({ id: 'trn-sacrifice', atIssue: 12, label: 'freely authorizes the final opening', kind: 'sacrifice' }),
    ]);
    expect(sibling).toMatchObject({ characterId: 'chr-sibling', startState: 'adrift', endState: 'committed' });
    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(JSON.parse(ctx.characterArcsJson)[0].transitions[1].id).toBe('trn-sacrifice');
  });

  it('drops arc / volume / episode edits that name no input finding', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L', summary: 'original summary' } });
    const v1 = await seasonsSvc.createSeason(s.id, { number: 1, title: 'Vol 1', synopsis: 'v1 original', episodeCountTarget: 2 });
    const v2 = await seasonsSvc.createSeason(s.id, { number: 2, title: 'Vol 2', synopsis: 'v2 original', episodeCountTarget: 2 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v1.id, title: 'Ep' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'ep original', status: 'empty' });
    const fresh = await issuesSvc.getIssue(issue.id);

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        // Untargeted arc rewrite — dropped. `resolves` naming an id the round
        // never handed out counts as naming nothing.
        arc: { resolves: ['f9'], logline: 'HIJACKED', summary: 'HIJACKED', themes: [], protagonistArc: '' },
        seasons: [
          { resolves: ['f1'], id: v1.id, number: 1, title: 'Vol 1', synopsis: 'v1 rewritten' },
          { resolves: [], id: v2.id, number: 2, title: 'Vol 2', synopsis: 'v2 collateral rewrite' },
        ],
        episodes: [{ seasonNumber: 1, episodeNumber: fresh.number, synopsis: 'ep collateral rewrite' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'volume 1 stages the eclipse twice', suggestion: 'fix' }],
    });

    expect(out.series.arc.logline).toBe('L');
    expect(out.series.arc.summary).toBe('original summary');
    expect(out.series.seasons[0].synopsis).toBe('v1 rewritten'); // the one targeted edit lands
    expect(out.series.seasons[1].synopsis).toBe('v2 original');
    expect(out.episodesResolved).toEqual([]);
    expect((await issuesSvc.getIssue(issue.id)).stages.idea.input).toBe('ep original');
  });

  it('applies an unkeyed response as a legacy patch (install still on the pre-#3724 prompt)', async () => {
    // A customized `pipeline-arc-resolve.md` never gets migration 245, so its
    // model can't know about `resolves`. Dropping everything would silently turn
    // auto-resolve into a round-burning no-op — those responses apply unkeyed,
    // still under the safer sparse-patch semantics.
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const v1 = await seasonsSvc.createSeason(s.id, { number: 1, title: 'Vol 1', synopsis: 'v1 original', episodeCountTarget: 2 });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        seasons: [{ id: v1.id, number: 1, title: 'Vol 1', synopsis: 'v1 rewritten' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'X', suggestion: 'Y' }],
    });

    expect(out.series.arc.logline).toBe('L2');
    expect(out.series.seasons[0].synopsis).toBe('v1 rewritten');
  });

  it('renders findings into the prompt stamped with stable findingIds', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { arc: { resolves: ['f2'], logline: 'L2', summary: 'S' }, seasons: [], notes: '' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    await planner.resolveVerifyIssues(s.id, {
      findings: [
        { severity: 'high', problem: 'first defect', suggestion: '' },
        { severity: 'high', problem: 'second defect', suggestion: '' },
      ],
    });

    const { findingsJson } = stageRunnerSpy.mock.calls[0][1];
    expect(JSON.parse(findingsJson).map((f) => f.findingId)).toEqual(['f1', 'f2']);
  });

  it('leaves the avoid section out of a first-attempt resolve', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { arc: { resolves: ['f1'], logline: 'L2', summary: 'S' }, seasons: [], notes: '' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'first defect', suggestion: '' }],
    });

    const ctx = stageRunnerSpy.mock.calls[0][1];
    // False, not "an empty array" — the prompt section is gated on this flag, so
    // a first attempt must render no avoid block rather than an empty one the
    // model has to decide to ignore.
    expect(ctx.hasAvoid).toBe(false);
    expect(JSON.parse(ctx.avoidJson)).toEqual([]);
  });

  it('renders a corrective pass\'s avoid list separately from the findings to close', async () => {
    // The autopilot's arc-verify gate reverts a resolve round that grew the
    // blocking count, then re-runs the resolver from the restored state with the
    // rejected attempt's findings as `avoid`. Those problems are NOT in the plan
    // any more, so they must never leak into `findingsJson` — asking the
    // resolver to close a problem the plan doesn't have is how a corrective pass
    // authors a fresh contradiction.
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { arc: { resolves: ['f1'], logline: 'L2', summary: 'S' }, seasons: [], notes: '' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'first defect', suggestion: 'fix it' }],
      avoid: [
        { severity: 'high', problem: 'the reverted rewrite dropped the mentor payoff', suggestion: '' },
        { problem: 'and split volume 2 in half', location: 'V2' },
      ],
    });

    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.hasAvoid).toBe(true);
    const avoid = JSON.parse(ctx.avoidJson);
    expect(avoid.map((f) => f.problem)).toEqual([
      'the reverted rewrite dropped the mentor payoff',
      'and split volume 2 in half',
    ]);
    // Normalized through the same shaper as the findings — a severity-less entry
    // gets the default rather than riding through as undefined.
    expect(avoid[1]).toMatchObject({ severity: 'medium', location: 'V2' });
    // The avoid entries carry no findingId and never appear as work to close.
    expect(ctx.avoidJson).not.toMatch(/findingId/);
    expect(JSON.parse(ctx.findingsJson).map((f) => f.problem)).toEqual(['first defect']);
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

  it('preserves series.arc.tickingClock when the resolve LLM does not author one', async () => {
    // Same drift class as readerMap above — the resolve prompt never authors a
    // ticking clock, so omitting it must not wipe the user's existing countdown.
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, {
      arc: {
        logline: 'L', summary: 'S', shape: 'man-in-hole',
        tickingClock: { enabled: true, label: 'The dam breaks', kind: 'deadline', stakes: 'town floods' },
      },
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: {
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
    expect(out.series.arc.tickingClock?.enabled).toBe(true);
    expect(out.series.arc.tickingClock?.label).toBe('The dam breaks');
  });

  it('applies episode-synopsis corrections the resolve LLM returns (heals episode-level findings)', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const season = await seasonsSvc.createSeason(s.id, { title: 'Vol 1', episodeCountTarget: 1 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: season.id, title: 'Ep' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'old synopsis that stages the Atrium', status: 'empty' });
    const fresh = await issuesSvc.getIssue(issue.id);

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        seasons: [{ id: season.id, number: season.number, title: 'Vol 1', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 1 }],
        episodes: [{ seasonNumber: season.number, episodeNumber: fresh.number, synopsis: 'corrected — the Atrium is NOT convened here' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'episode 1 stages the Atrium', suggestion: 'move it' }],
    });

    expect(out.episodesResolved).toHaveLength(1);
    expect(out.episodesResolved[0]).toMatchObject({ issueId: issue.id, number: fresh.number, clearedBeats: false });
    const updated = await issuesSvc.getIssue(issue.id);
    expect(updated.stages.idea.input).toBe('corrected — the Atrium is NOT convened here');
    // The entry doubles as the rollback's mutation manifest: it reports the
    // value this call actually left standing.
    expect(planner.resolvedEpisodeEdits(out)).toEqual([
      { issueId: issue.id, idea: { input: updated.stages.idea.input, output: '', status: updated.stages.idea.status } },
    ]);
  });

  // The pre-episode arc-spine gate verifies an episode-EMPTY plan (#3789). A
  // resolver handed the full lineup answered spine findings with episode
  // rewrites the gate never read: they could not close what was flagged, and
  // the round got reverted for doubling the blocker count. Both halves of the
  // loop have to see the same plan.
  it('renders the resolve prompt with empty episode arrays in spineOnly mode', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const season = await seasonsSvc.createSeason(s.id, { title: 'Vol 1', episodeCountTarget: 1 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: season.id, title: 'Ep' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'seeded episode synopsis', status: 'empty' });

    stageRunnerSpy = vi.fn(async () => ({
      content: { arc: { logline: 'L2', summary: 'S', themes: [], protagonistArc: '' }, seasons: [], notes: '' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    await planner.resolveVerifyIssues(s.id, {
      spineOnly: true,
      findings: [{ severity: 'high', problem: 'spine problem', suggestion: 'fix the arc' }],
    });

    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.arcSpineOnly).toBe(true);
    expect(JSON.parse(ctx.seasonsTreeJson)[0].episodes).toEqual([]);
    expect(ctx.seasonsTreeJson).not.toContain('seeded episode synopsis');
  });

  it('discards episode edits in spineOnly mode and leaves the planned synopses untouched', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const season = await seasonsSvc.createSeason(s.id, { title: 'Vol 1', episodeCountTarget: 1 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: season.id, title: 'Ep' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'original episode synopsis', status: 'empty' });
    const fresh = await issuesSvc.getIssue(issue.id);

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { resolves: ['f1'], logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        seasons: [],
        // A stale/customized installed prompt can still return these — the
        // server drops them rather than trusting the template alone.
        episodes: [{ resolves: ['f1'], seasonNumber: season.number, episodeNumber: fresh.number, synopsis: 'out-of-scope rewrite' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      spineOnly: true,
      findings: [{ severity: 'high', problem: 'spine problem', suggestion: 'fix the arc' }],
    });

    // The arc/volume half of the patch still lands — this scopes the round, it
    // does not disable it.
    expect(out.series.arc.logline).toBe('L2');
    expect(out.episodesResolved).toEqual([]);
    const untouched = await issuesSvc.getIssue(issue.id);
    expect(untouched.stages.idea.input).toBe('original episode synopsis');
  });

  it('clears stale beats when correcting an episode that was already expanded', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const season = await seasonsSvc.createSeason(s.id, { title: 'Vol 1', episodeCountTarget: 1 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: season.id, title: 'Ep' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'old synopsis', output: 'BEAT 1\nBEAT 2', status: 'ready' });
    const fresh = await issuesSvc.getIssue(issue.id);

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        seasons: [{ id: season.id, number: season.number, title: 'Vol 1', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 1 }],
        episodes: [{ seasonNumber: season.number, episodeNumber: fresh.number, synopsis: 'corrected synopsis' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'contradiction', suggestion: 'fix' }],
    });

    expect(out.episodesResolved[0].clearedBeats).toBe(true);
    const updated = await issuesSvc.getIssue(issue.id);
    expect(updated.stages.idea.input).toBe('corrected synopsis');
    expect(updated.stages.idea.output).toBe(''); // stale beats cleared so beatSheet regenerates
    expect(updated.stages.idea.status).toBe('empty');
  });

  it('leaves a locked idea stage untouched and reports it skipped', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const season = await seasonsSvc.createSeason(s.id, { title: 'Vol 1', episodeCountTarget: 1 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: season.id, title: 'Ep' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'frozen synopsis', status: 'edited', locked: true });
    const fresh = await issuesSvc.getIssue(issue.id);

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        seasons: [{ id: season.id, number: season.number, title: 'Vol 1', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 1 }],
        episodes: [{ seasonNumber: season.number, episodeNumber: fresh.number, synopsis: 'attempted overwrite' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'contradiction', suggestion: 'fix' }],
    });

    expect(out.episodesResolved[0].skipped).toBe('locked');
    const updated = await issuesSvc.getIssue(issue.id);
    expect(updated.stages.idea.input).toBe('frozen synopsis'); // unchanged
  });

  it('fails safe (no-match) when a correction names a season the matched-number issue is NOT in', async () => {
    // Guard against a numbering-scheme mismatch: the arc tree numbers episodes
    // series-globally, but if the resolve LLM ever returns a per-season
    // episodeNumber, a season-agnostic fallback would silently rewrite the wrong
    // season's issue. With a resolvable seasonNumber we now REQUIRE the season to
    // match — a mismatch is dropped, not mis-applied to another season's issue.
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const s1 = await seasonsSvc.createSeason(s.id, { title: 'Vol 1', episodeCountTarget: 1 });
    const s2 = await seasonsSvc.createSeason(s.id, { title: 'Vol 2', episodeCountTarget: 1 });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, seasonId: s1.id, title: 'Ep' });
    await issuesSvc.updateStage(issue.id, 'idea', { input: 'season 1 synopsis', status: 'empty' });
    const fresh = await issuesSvc.getIssue(issue.id);

    // Correction names season 2 but the only issue with this number is in season 1.
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        arc: { logline: 'L2', summary: 'S', themes: [], protagonistArc: '' },
        seasons: [
          { id: s1.id, number: s1.number, title: 'Vol 1', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 1 },
          { id: s2.id, number: s2.number, title: 'Vol 2', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 1 },
        ],
        episodes: [{ seasonNumber: s2.number, episodeNumber: fresh.number, synopsis: 'WRONG-SEASON overwrite' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, {
      findings: [{ severity: 'high', problem: 'contradiction', suggestion: 'fix' }],
    });

    expect(out.episodesResolved[0].skipped).toBe('no-match');
    const updated = await issuesSvc.getIssue(issue.id);
    expect(updated.stages.idea.input).toBe('season 1 synopsis'); // NOT overwritten
  });
});

// The arc gate's per-finding fallback (#3780) sends ONE finding, but that alone
// never bounded the EDIT: every entry in a single-finding response trivially
// names that finding, so `selectFindingKeyedEdits` passed whole-arc rewrites and
// each "isolated" attempt regressed the blocker set exactly like the whole-set
// pass it escalated from. `isolated` mode requires the response to BE one causal
// patch and discards it before persistence otherwise.
describe('arcPlanner — resolveVerifyIssues (isolated single-finding repairs)', () => {
  const finding = [{ severity: 'high', location: 'volume 1', problem: 'volume 1 promises a payoff it never lands', suggestion: 'name the payoff' }];

  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  async function setupTwoVolumeSeries() {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'L', summary: 'The choir wakes. The city answers.', themes: ['legacy'], protagonistArc: 'From surveyor to founder.' },
    });
    const v1 = await seasonsSvc.createSeason(s.id, { title: 'Vol 1', episodeCountTarget: 8, synopsis: 'The foundry falls silent. Nobody says why.' });
    const v2 = await seasonsSvc.createSeason(s.id, { title: 'Vol 2', episodeCountTarget: 8, synopsis: 'The diaspora scatters. A signal follows them.' });
    return { s, v1, v2 };
  }

  it('discards an isolated candidate that edits more than one record, persisting nothing', async () => {
    const { s, v1, v2 } = await setupTwoVolumeSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        arc: { resolves: ['f1'], summaryEdits: [{ find: 'The city answers.', replace: 'The city answers in kind.' }] },
        seasons: [
          { resolves: ['f1'], id: v1.id, number: v1.number, title: 'Vol 1', synopsisEdits: [{ find: 'Nobody says why.', replace: 'Nobody says why until the ledger surfaces.' }] },
          { resolves: ['f1'], id: v2.id, number: v2.number, title: 'Vol 2', synopsisEdits: [{ find: 'A signal follows them.', replace: 'A signal follows them home.' }] },
        ],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, { findings: finding, isolated: true });

    expect(out.applied).toBe(false);
    expect(out.reason).toMatch(/edits 3 records/);
    // Nothing reached the store — the gate has no rewrite to roll back and no
    // reason to spend a verification round discovering that.
    const after = await seriesSvc.getSeries(s.id);
    expect(after.arc.summary).toBe('The choir wakes. The city answers.');
    expect(after.seasons.map((v) => v.synopsis)).toEqual([
      'The foundry falls silent. Nobody says why.',
      'The diaspora scatters. A signal follows them.',
    ]);
  });

  it('discards an isolated candidate that changes two fields on one record', async () => {
    const { s, v1 } = await setupTwoVolumeSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        seasons: [{
          resolves: ['f1'],
          id: v1.id,
          number: v1.number,
          title: 'Vol 1',
          logline: 'a brand new logline',
          synopsisEdits: [{ find: 'Nobody says why.', replace: 'Nobody says why until the ledger surfaces.' }],
        }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, { findings: finding, isolated: true });

    expect(out.applied).toBe(false);
    expect(out.reason).toMatch(/changes 2 fields on volume 1/);
    const after = await seriesSvc.getSeries(s.id);
    expect(after.seasons[0].synopsis).toBe('The foundry falls silent. Nobody says why.');
    expect(after.seasons[0].logline).toBe('');
  });

  it('discards an isolated candidate that would add a volume', async () => {
    const { s } = await setupTwoVolumeSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        seasons: [{ resolves: ['f1'], number: 3, title: 'Vol 3', synopsis: 'The payoff gets its own volume.' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, { findings: finding, isolated: true });

    expect(out.applied).toBe(false);
    expect(out.reason).toMatch(/add a new volume/);
    expect((await seriesSvc.getSeries(s.id)).seasons).toHaveLength(2);
  });

  it('keeps a one-patch candidate, ignoring echoed identity fields that change nothing', async () => {
    const { s, v1 } = await setupTwoVolumeSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        seasons: [{
          // id / number / title / episodeCountTarget are echoed exactly as
          // stored — the prompt asks for them, so "present" must not read as
          // "changed" or every real one-patch response would be discarded.
          resolves: ['f1'],
          id: v1.id,
          number: v1.number,
          title: 'Vol 1',
          episodeCountTarget: 8,
          synopsisEdits: [{ find: 'Nobody says why.', replace: 'Nobody says why until the ledger surfaces.' }],
        }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, { findings: finding, isolated: true });

    expect(out.applied).toBe(true);
    expect(out.reason).toBeUndefined();
    const after = await seriesSvc.getSeries(s.id);
    expect(after.seasons[0].synopsis).toBe('The foundry falls silent. Nobody says why until the ledger surfaces.');
    expect(after.seasons[1].synopsis).toBe('The diaspora scatters. A signal follows them.');
  });

  it('discards a candidate that only echoes stored values back', async () => {
    const { s, v1 } = await setupTwoVolumeSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        seasons: [{ resolves: ['f1'], id: v1.id, number: v1.number, title: 'Vol 1', episodeCountTarget: 8 }],
        notes: 'nothing to change here',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, { findings: finding, isolated: true });

    expect(out.applied).toBe(false);
    expect(out.reason).toMatch(/changed nothing/);
    expect(out.notes).toBe('nothing to change here');
  });

  it('tells the prompt it is an isolated repair, and does not on a whole-set pass', async () => {
    const { s, v1 } = await setupTwoVolumeSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        seasons: [{ resolves: ['f1'], id: v1.id, synopsisEdits: [{ find: 'Nobody says why.', replace: 'Nobody says why yet.' }] }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    await planner.resolveVerifyIssues(s.id, { findings: finding, isolated: true });
    expect(stageRunnerSpy.mock.calls[0][1].isolatedRepair).toBe(true);

    await planner.resolveVerifyIssues(s.id, { findings: finding });
    expect(stageRunnerSpy.mock.calls[1][1].isolatedRepair).toBe(false);
  });

  // The constrained mode is the bounded FALLBACK only: coordinated cross-record
  // repairs stay available to the whole-set and corrective passes, which is
  // where a genuine multi-record continuity finding gets fixed.
  it('leaves the whole-set pass free to edit several records', async () => {
    const { s, v1, v2 } = await setupTwoVolumeSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        arc: { resolves: ['f1'], summaryEdits: [{ find: 'The city answers.', replace: 'The city answers in kind.' }] },
        seasons: [
          { resolves: ['f1'], id: v1.id, synopsisEdits: [{ find: 'Nobody says why.', replace: 'Nobody says why until the ledger surfaces.' }] },
          { resolves: ['f1'], id: v2.id, synopsisEdits: [{ find: 'A signal follows them.', replace: 'A signal follows them home.' }] },
        ],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, { findings: finding });

    expect(out.applied).toBe(true);
    const after = await seriesSvc.getSeries(s.id);
    expect(after.arc.summary).toBe('The choir wakes. The city answers in kind.');
    expect(after.seasons[0].synopsis).toContain('until the ledger surfaces');
    expect(after.seasons[1].synopsis).toContain('follows them home');
  });
});

describe('isolatedCandidateRejection (pure one-patch bound)', () => {
  const series = {
    arc: { logline: 'L', summary: 'One. Two.', themes: ['a'], protagonistArc: 'P' },
    seasons: [{ id: 'sea-1', number: 1, title: 'Vol 1', synopsis: 'Alpha. Beta.', endingHook: 'hook', episodeCountTarget: 8, themes: [] }],
    characterArcs: [{
      characterId: 'chr-11111111-1111-4111-8111-111111111111',
      characterName: 'Wren',
      want: 'the ledger',
      need: 'to be believed',
      startState: 'alone',
      endState: 'trusted',
            transitions: [{ id: 'trn-1', kind: 'decision', label: 'burns the ledger', atIssue: 4, atSceneAnchor: '', note: '' }],
    }],
  };
  // Only the four edit lists — the checker reads the selected edits, never the
  // drop counters `selectFindingKeyedEdits` reports alongside them.
  const noEdits = { arc: null, characterArcs: [], seasons: [], episodes: [] };
  const rejection = (edits, exactTextMode = true) => planner.isolatedCandidateRejection(
    { ...noEdits, ...edits },
    { exactTextMode, series },
  );

  it('accepts one exact-text replacement on one volume', () => {
    expect(rejection({ seasons: [{ id: 'sea-1', synopsisEdits: [{ find: 'Beta.', replace: 'Beta rewritten.' }] }] })).toBeNull();
  });

  it('accepts one short scalar change', () => {
    expect(rejection({ seasons: [{ id: 'sea-1', episodeCountTarget: 9 }] })).toBeNull();
  });

  it('accepts one existing character-transition patch, however many of its fields move', () => {
    expect(rejection({
      characterArcs: [{
        characterId: 'chr-11111111-1111-4111-8111-111111111111',
        transitions: [{ id: 'trn-1', label: 'spares the ledger', atIssue: 5 }],
      }],
    })).toBeNull();
  });

  it('rejects two replacements even inside one field', () => {
    expect(rejection({
      seasons: [{ id: 'sea-1', synopsisEdits: [{ find: 'Alpha.', replace: 'Alpha!' }, { find: 'Beta.', replace: 'Beta!' }] }],
    })).toMatch(/changes 2 fields/);
  });

  it('does not count the long-prose spelling the applier ignores', () => {
    // Under exact-text mode a directly-returned `synopsis` is never persisted,
    // so counting it would reject a candidate over an edit that was a no-op.
    expect(rejection({
      seasons: [{ id: 'sea-1', synopsis: 'wholesale rewrite', synopsisEdits: [{ find: 'Beta.', replace: 'Beta rewritten.' }] }],
    })).toBeNull();
    // Outside exact-text mode the same field IS the change.
    expect(rejection({ seasons: [{ id: 'sea-1', synopsis: 'wholesale rewrite' }] }, false)).toBeNull();
  });

  it('counts what the exact-text applier would land, not what was asked for', () => {
    // A replacement whose anchor isn't in the stored text is skipped by
    // applyExactTextEdits, so it changes nothing — counting it would discard a
    // candidate whose persisted effect was exactly one change.
    expect(rejection({
      seasons: [{
        id: 'sea-1',
        synopsisEdits: [
          { find: 'Beta.', replace: 'Beta rewritten.' },
          { find: 'text that is not in the synopsis', replace: 'never lands' },
        ],
      }],
    })).toBeNull();
    // …and a candidate whose every replacement is unanchored lands nothing at all.
    expect(rejection({
      seasons: [{ id: 'sea-1', synopsisEdits: [{ find: 'not present either', replace: 'x' }] }],
    })).toMatch(/changed nothing/);
  });

  it('does not count edits the appliers would discard anyway', () => {
    expect(rejection({
      characterArcs: [
        { characterName: 'Nobody', want: 'invented' }, // unmatched arc — never minted
        {
          characterId: 'chr-11111111-1111-4111-8111-111111111111',
          transitions: [
            { label: 'no id, dropped by the merge' },
            { id: 'trn-missing', label: 'unmatched id, dropped by the merge' },
            { id: 'trn-1', label: 'burns the ledger' }, // identical to stored
          ],
          want: 'the ledger archive',
        },
      ],
    })).toBeNull();
  });
});

describe('selectFindingKeyedEdits (pure resolve-edit filter, #3724)', () => {
  const findings = [{ problem: 'a' }, { problem: 'b' }];
  const select = (content) => planner.selectFindingKeyedEdits(content, findings);

  it('keeps edits naming an input finding and drops the rest', () => {
    const out = select({
      arc: { resolves: ['f2'], logline: 'x' },
      characterArcs: [{ resolves: ['f2'], characterId: 'chr-a' }, { resolves: ['f8'], characterId: 'chr-b' }],
      seasons: [{ resolves: ['f1'] }, { resolves: ['f7'] }, { resolves: [] }],
      episodes: [{ resolves: ['f1'] }, {}],
    });
    expect(out.legacy).toBe(false);
    expect(out.arc?.logline).toBe('x');
    expect(out.arcDropped).toBe(false);
    expect(out.characterArcs).toHaveLength(1);
    expect(out.characterArcsDropped).toBe(1);
    expect(out.seasons).toHaveLength(1);
    expect(out.seasonsDropped).toBe(2);
    expect(out.episodes).toHaveLength(1);
    expect(out.episodesDropped).toBe(1);
  });

  it('normalizes ids (case + whitespace) and ignores non-string entries', () => {
    const out = select({ seasons: [{ resolves: [' F1 ', 42, null, 'f1'] }] });
    expect(out.seasons).toHaveLength(1);
  });

  it('drops an untargeted arc block while keeping the volumes that are targeted', () => {
    const out = select({ arc: { resolves: [] }, seasons: [{ resolves: ['f1'] }] });
    expect(out.arc).toBeNull();
    expect(out.arcDropped).toBe(true);
    expect(out.seasons).toHaveLength(1);
  });

  it('falls back to legacy (apply-all) only when NOTHING in the response declares resolves', () => {
    const legacy = select({ arc: { logline: 'x' }, seasons: [{ id: 's1' }], episodes: [{ synopsis: 'y' }] });
    expect(legacy).toMatchObject({ legacy: true, arcDropped: false, seasonsDropped: 0, episodesDropped: 0 });
    expect(legacy.arc?.logline).toBe('x');
    // One keyed entry proves the model is on the new contract — the unkeyed
    // siblings in the SAME response are then genuine drops, not legacy.
    expect(select({ seasons: [{ resolves: ['f1'] }, { id: 's2' }] }))
      .toMatchObject({ legacy: false, seasonsDropped: 1 });
  });

  // #3789 — a spine round's findings were produced against an episode-empty
  // plan, so every episode edit is out of scope no matter which finding it
  // names. Counted apart from `episodesDropped` (a different diagnosis) and
  // applied even to a legacy unkeyed response, which is the one an install with
  // a pre-#3789 prompt will send.
  it('drops every episode edit in spineOnly mode, keyed or not', () => {
    const spine = (content) => planner.selectFindingKeyedEdits(content, findings, { spineOnly: true });
    const keyed = spine({
      arc: { resolves: ['f1'], logline: 'x' },
      seasons: [{ resolves: ['f1'] }],
      episodes: [{ resolves: ['f1'] }, { resolves: ['f2'] }],
    });
    expect(keyed.arc?.logline).toBe('x');
    expect(keyed.seasons).toHaveLength(1);
    expect(keyed.episodes).toEqual([]);
    expect(keyed.episodesOutOfScope).toBe(2);
    expect(keyed.episodesDropped).toBe(0);
    expect(spine({ episodes: [{ synopsis: 'y' }] }))
      .toMatchObject({ legacy: true, episodes: [], episodesOutOfScope: 1 });
    // Full-arc rounds are untouched — episode corrections are how an
    // episode-scoped finding converges there.
    expect(select({ episodes: [{ resolves: ['f1'] }] }))
      .toMatchObject({ episodesOutOfScope: 0 });
  });

  it('tolerates a missing/garbage response', () => {
    expect(select(null)).toMatchObject({ legacy: true, arc: null, characterArcs: [], seasons: [], episodes: [] });
    expect(select({ arc: 'not an object', seasons: 'nope', episodes: [null, 3] }))
      .toMatchObject({ arc: null, seasons: [], episodes: [] });
  });
});

describe('arcPlanner — snapshotArcState / restoreArcState (resolve-round rollback)', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  // Stand up the shape one auto-resolve round can touch: an arc, two volumes,
  // and an episode under each carrying a planning synopsis.
  async function seedArc() {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'original logline', summary: 'original summary' },
      characterArcs: [{
        characterId: 'chr-lead', characterName: 'Lead', want: 'escape', need: 'trust',
        startState: 'guarded', endState: 'open',
        transitions: [{ id: 'trn-sacrifice', kind: 'sacrifice', atIssue: 12, label: 'chooses the crew' }],
      }],
    });
    const v1 = await seasonsSvc.createSeason(s.id, { title: 'Volume 1', synopsis: 'v1 synopsis', episodeCountTarget: 2 });
    const v2 = await seasonsSvc.createSeason(s.id, { title: 'Volume 2', synopsis: 'v2 synopsis', episodeCountTarget: 2 });
    const e1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v1.id, title: 'Ep 1' });
    const e2 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v2.id, title: 'Ep 2' });
    await issuesSvc.updateStage(e1.id, 'idea', { input: 'e1 planning synopsis' });
    await issuesSvc.updateStage(e2.id, 'idea', { input: 'e2 planning synopsis' });
    return { s, v1, v2, e1, e2 };
  }

  it('puts back the arc, the volume list and the episode synopses a round rewrote', async () => {
    const { s, v1, v2, e1, e2 } = await seedArc();
    const snapshot = await planner.snapshotArcState(s.id);

    // Simulate the damage a regressive resolve round does: rewrite the arc,
    // rewrite a volume, mint a third one, move an episode onto it, and rewrite
    // the other episode's synopsis (clearing its beats the way
    // applyEpisodeResolutions does).
    const minted = await seasonsSvc.createSeason(s.id, { title: 'Volume 1', synopsis: 'duplicate', episodeCountTarget: 2 });
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'rewritten logline', summary: 'rewritten summary' },
      characterArcs: [{
        characterId: 'chr-lead', characterName: 'Lead', want: 'escape', need: 'control',
        startState: 'guarded', endState: 'alone',
        transitions: [{ id: 'trn-sacrifice', kind: 'sacrifice', atIssue: 11, label: 'wrong milestone' }],
      }],
      seasons: [{ ...v1, synopsis: 'rewritten v1' }, v2, minted],
    });
    await issuesSvc.updateIssue(e2.id, { seasonId: minted.id });
    await issuesSvc.updateStage(e1.id, 'idea', { input: 'rewritten e1 synopsis', output: '', status: 'empty' });

    const result = await planner.restoreArcState(s.id, snapshot);
    expect(result).toMatchObject({ restored: true, episodesRestored: 1, reassignedIssueCount: 1 });

    const series = await seriesSvc.getSeries(s.id);
    expect(series.arc.logline).toBe('original logline');
    expect(series.characterArcs[0]).toMatchObject({ need: 'trust', endState: 'open' });
    expect(series.characterArcs[0].transitions[0]).toMatchObject({ id: 'trn-sacrifice', atIssue: 12, label: 'chooses the crew' });
    expect(series.seasons.map((x) => x.id)).toEqual([v1.id, v2.id]);
    expect(series.seasons[0].synopsis).toBe('v1 synopsis');
    // The minted volume is gone, so the episode it took has to come back with
    // it — otherwise the rollback strands it in the ungrouped bucket.
    expect((await issuesSvc.getIssue(e2.id)).seasonId).toBe(v2.id);
    expect((await issuesSvc.getIssue(e1.id)).stages.idea.input).toBe('e1 planning synopsis');
  });

  // The rollback used to treat ANY difference from the snapshot as the round's
  // own work — see `createArcMutationLedger` for the run that exposed it.
  describe('restores only the episodes the resolve round is on record as writing', () => {
    // The damage every case below shares: a rewritten arc, a minted volume that
    // took an episode off its own, and a synopsis rewrite on e1.
    // Bound once so the manifest provably reports the value that was written.
    const WROTE = { input: 'resolver rewrote e1', output: '', status: 'empty' };

    async function regressiveRound({ s, v1, v2, e1 }) {
      const minted = await seasonsSvc.createSeason(s.id, { title: 'Volume 1', synopsis: 'duplicate', episodeCountTarget: 2 });
      await seriesSvc.updateSeries(s.id, {
        arc: { logline: 'rewritten logline', summary: 'rewritten summary' },
        seasons: [{ ...v1, synopsis: 'rewritten v1' }, v2, minted],
      });
      await issuesSvc.updateIssue(e1.id, { seasonId: minted.id });
      await issuesSvc.updateStage(e1.id, 'idea', { ...WROTE });
      return { e1Edit: { issueId: e1.id, idea: { ...WROTE } } };
    }

    it('reverts its own episode write and the volume it drove, and keeps an unrelated one', async () => {
      const seed = await seedArc();
      const { s, v2, e1, e2 } = seed;
      const snapshot = await planner.snapshotArcState(s.id);
      const { e1Edit } = await regressiveRound(seed);
      // Lands between the snapshot and the rollback, from outside this round.
      await issuesSvc.updateStage(e2.id, 'idea', { input: 'edited elsewhere mid-verify' });

      const result = await planner.restoreArcState(s.id, snapshot, { episodeEdits: [e1Edit] });
      expect(result).toMatchObject({ restored: true, episodesRestored: 1, reassignedIssueCount: 1 });

      const series = await seriesSvc.getSeries(s.id);
      expect(series.arc.logline).toBe('original logline');
      expect(series.seasons[0].synopsis).toBe('v1 synopsis');
      expect((await issuesSvc.getIssue(e1.id)).stages.idea.input).toBe('e1 planning synopsis');
      // The minted volume is gone, so its episode still has to come back with it.
      expect((await issuesSvc.getIssue(e1.id)).seasonId).toBe(seed.v1.id);
      expect((await issuesSvc.getIssue(e2.id)).stages.idea.input).toBe('edited elsewhere mid-verify');
      expect((await issuesSvc.getIssue(e2.id)).seasonId).toBe(v2.id);
    });

    it('leaves an episode it wrote alone once a later write lands on top of it', async () => {
      const seed = await seedArc();
      const { s, e1 } = seed;
      const snapshot = await planner.snapshotArcState(s.id);
      const { e1Edit } = await regressiveRound(seed);
      await issuesSvc.updateStage(e1.id, 'idea', { input: 'a human kept editing after the resolver' });

      const result = await planner.restoreArcState(s.id, snapshot, { episodeEdits: [e1Edit] });
      expect(result).toMatchObject({ restored: true, episodesRestored: 0 });
      expect((await issuesSvc.getIssue(e1.id)).stages.idea.input).toBe('a human kept editing after the resolver');
      // The arc-level revert still happens — only the episode is off limits.
      expect((await seriesSvc.getSeries(s.id)).arc.logline).toBe('original logline');
    });

    it('restores no synopsis at all for an arc-spine round (empty manifest)', async () => {
      const seed = await seedArc();
      const { s, e1 } = seed;
      const snapshot = await planner.snapshotArcState(s.id);
      await regressiveRound(seed);

      const result = await planner.restoreArcState(s.id, snapshot, { episodeEdits: [] });
      expect(result).toMatchObject({ restored: true, episodesRestored: 0, reassignedIssueCount: 1 });
      expect((await issuesSvc.getIssue(e1.id)).stages.idea.input).toBe(WROTE.input);
      expect((await seriesSvc.getSeries(s.id)).seasons.map((x) => x.id)).toEqual([seed.v1.id, seed.v2.id]);
      expect((await issuesSvc.getIssue(e1.id)).seasonId).toBe(seed.v1.id);
    });
  });

  it('leaves a locked idea stage alone (the resolve pass never touched it)', async () => {
    const { s, e1 } = await seedArc();
    const snapshot = await planner.snapshotArcState(s.id);
    await issuesSvc.updateStage(e1.id, 'idea', { input: 'user edit after the snapshot', locked: true });

    const result = await planner.restoreArcState(s.id, snapshot);
    expect(result.episodesRestored).toBe(0);
    expect((await issuesSvc.getIssue(e1.id)).stages.idea.input).toBe('user edit after the snapshot');
  });

  it('refuses a snapshot that belongs to another series, and a missing one', async () => {
    const { s } = await seedArc();
    const other = await planner.snapshotArcState((await seedArc()).s.id);
    expect(await planner.restoreArcState(s.id, other)).toMatchObject({ restored: false });
    expect(await planner.restoreArcState(s.id, null)).toMatchObject({ restored: false });
    // Untouched by the refused restores.
    expect((await seriesSvc.getSeries(s.id)).arc.logline).toBe('original logline');
  });

  it('snapshots by value — a later write cannot mutate what was captured', async () => {
    const { s } = await seedArc();
    const snapshot = await planner.snapshotArcState(s.id);
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'mutated', summary: 'mutated' },
      characterArcs: [{
        characterId: 'chr-lead', characterName: 'Lead', want: 'mutated', need: 'mutated',
        startState: 'mutated', endState: 'mutated', transitions: [],
      }],
    });
    expect(snapshot.arc.logline).toBe('original logline');
    expect(snapshot.characterArcs[0].want).toBe('escape');
  });
});

describe('arcPlanner — shapeEpisodeResolutions', () => {
  it('keeps well-formed entries and drops malformed ones', () => {
    const out = planner.shapeEpisodeResolutions([
      { seasonNumber: 2, episodeNumber: 13, synopsis: '  fixed  ' },
      { episodeNumber: 5, synopsis: 'no season is fine' },
      { seasonNumber: 1, episodeNumber: 2 },             // no synopsis → dropped
      { seasonNumber: 1, episodeNumber: 'x', synopsis: 'bad number' }, // non-int → dropped
      { seasonNumber: 1, synopsis: 'no episode number' }, // → dropped
    ]);
    expect(out).toEqual([
      { seasonNumber: 2, episodeNumber: 13, synopsis: 'fixed' },
      { seasonNumber: null, episodeNumber: 5, synopsis: 'no season is fine' },
    ]);
  });

  it('returns [] for non-array input', () => {
    expect(planner.shapeEpisodeResolutions(undefined)).toEqual([]);
    expect(planner.shapeEpisodeResolutions(null)).toEqual([]);
    expect(planner.shapeEpisodeResolutions('nope')).toEqual([]);
  });

  it('caps at RESOLVE_EPISODE_MAX entries', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ episodeNumber: i + 1, synopsis: `s${i}` }));
    expect(planner.shapeEpisodeResolutions(many)).toHaveLength(50);
  });

  it('cannot inflate a repaired episode beyond the generation synopsis budget', () => {
    const overlong = `${'One complete dramatic sentence. '.repeat(180)}unfinished tail`;
    const [episode] = planner.shapeEpisodeResolutions([
      { seasonNumber: 1, episodeNumber: 4, synopsis: overlong },
    ]);
    expect(episode.synopsis.length).toBeLessThanOrEqual(4_000);
    expect(episode.synopsis).toMatch(/[.!?]$/);
    expect(episode.synopsis).not.toContain('unfinished tail');
  });
});

describe('arcPlanner — resolvedEpisodeEdits (rollback mutation manifest)', () => {
  it('carries only the writes that landed, with the value they left', () => {
    expect(planner.resolvedEpisodeEdits({
      episodesResolved: [
        { issueId: 'iss-1', number: 1, idea: { input: 'rewritten', output: '', status: 'empty' } },
        { issueId: 'iss-2', number: 2, skipped: 'locked' },
        { issueId: 'iss-3', number: 3, skipped: 'write-failed' },
        { seasonNumber: 2, episodeNumber: 9, skipped: 'no-match' },
      ],
    })).toEqual([{ issueId: 'iss-1', idea: { input: 'rewritten', output: '', status: 'empty' } }]);
  });

  it('is empty for a round that reported nothing — including an arc-spine one', () => {
    expect(planner.resolvedEpisodeEdits({ applied: true, episodesResolved: [] })).toEqual([]);
    expect(planner.resolvedEpisodeEdits({ applied: false })).toEqual([]);
    expect(planner.resolvedEpisodeEdits(null)).toEqual([]);
  });
});

// Shared by every commitSeasonsWithRemap case below — they all commit a fresh
// draft arc and vary only the seasons.
const DRAFT_ARC = Object.freeze({ logline: 'L', summary: '', themes: [], protagonistArc: '', shape: null, status: 'draft' });

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
      arc: DRAFT_ARC,
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
      arc: DRAFT_ARC,
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
      arc: DRAFT_ARC,
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

  it('self-heals a pre-existing duplicate volume number and keeps its episodes attached', async () => {
    const s = await setupSeries();
    const keep = await seasonsSvc.createSeason(s.id, { number: 1, title: 'Salt at the Root', episodeCountTarget: 12 });
    const dupe = await seasonsSvc.createSeason(s.id, { number: 1, title: 'Salt at the Root', episodeCountTarget: 12 });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: keep.id, title: 'Ep 1' });
    // An episode stranded under the duplicate must follow the survivor, not
    // fall into the ungrouped bucket.
    const i2 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: dupe.id, title: 'Stranded' });

    const cur = await seriesSvc.getSeries(s.id);
    expect(cur.seasons).toHaveLength(2);

    // A perfectly ordinary arc write — the heal rides along with it.
    const out = await planner.commitSeasonsWithRemap(
      cur,
      { arc: DRAFT_ARC, seasons: cur.seasons },
      { preserveDroppedSeasons: true },
    );

    expect(out.series.seasons).toHaveLength(1);
    expect(out.series.seasons[0].id).toBe(keep.id);
    expect((await issuesSvc.getIssue(i1.id)).seasonId).toBe(keep.id);
    expect((await issuesSvc.getIssue(i2.id)).seasonId).toBe(keep.id);
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
      arc: DRAFT_ARC,
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
      arc: DRAFT_ARC,
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
      arc: DRAFT_ARC,
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

  // `preserveDroppedSeasons` — the autopilot's unlock-for-run mode clears the
  // per-season locks above, so this is what keeps a rewrite from DELETING a
  // volume once they're gone.
  it('keeps an UNLOCKED season the rewrite dropped, and still applies rewrites to survivors', async () => {
    const s = await setupSeries();
    const dropped = await seasonsSvc.createSeason(s.id, { title: 'Would vanish', episodeCountTarget: 3, number: 1 });
    const kept = await seasonsSvc.createSeason(s.id, { title: 'Old title', episodeCountTarget: 3, number: 2 });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: dropped.id, title: 'Pilot' });
    const cur = await seriesSvc.getSeries(s.id);
    const out = await planner.commitSeasonsWithRemap(cur, {
      arc: DRAFT_ARC,
      seasons: [{ id: kept.id, number: 2, title: 'New title', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 4, themes: [] }],
    }, { preserveDroppedSeasons: true });
    expect(out.series.seasons.map((x) => x.id)).toContain(dropped.id);
    expect(out.series.seasons.find((x) => x.id === kept.id).title).toBe('New title');
    // The dropped volume's issue stays attached — nothing was reassigned away.
    expect(await issuesSvc.getIssue(i1.id).then((i) => i.seasonId)).toBe(dropped.id);
  });

  // Regression: preserved records must survive `sanitizeSeasonList`'s
  // first-N cap. Appending them meant a rewrite returning a full cap's worth of
  // brand-new volumes pushed every existing volume past the cap, the sanitizer
  // dropped them, and the remap then reassigned their issues — the exact
  // deletion `preserveDroppedSeasons` exists to refuse.
  it('keeps existing volumes when the rewrite returns a full cap of brand-new ones', async () => {
    const s = await setupSeries();
    const existing = await seasonsSvc.createSeason(s.id, { title: 'Must survive', episodeCountTarget: 3, number: 1 });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: existing.id, title: 'Pilot' });
    const cur = await seriesSvc.getSeries(s.id);
    // SEASONS_PER_SERIES_MAX brand-new volumes, none reusing the existing id.
    const flood = Array.from({ length: 50 }, (_, i) => ({
      id: `sea-new-${i}`, number: i + 10, title: `New ${i}`,
      logline: '', synopsis: '', endingHook: '', episodeCountTarget: 3, themes: [],
    }));
    const out = await planner.commitSeasonsWithRemap(cur, { arc: DRAFT_ARC, seasons: flood }, { preserveDroppedSeasons: true });
    expect(out.series.seasons.map((x) => x.id)).toContain(existing.id);
    // Its issue was never reassigned to a surviving volume.
    expect(await issuesSvc.getIssue(i1.id).then((i) => i.seasonId)).toBe(existing.id);
  });

  it('still drops an unlocked season when the flag is off (default behavior unchanged)', async () => {
    const s = await setupSeries();
    const dropped = await seasonsSvc.createSeason(s.id, { title: 'Would vanish', episodeCountTarget: 3, number: 1 });
    const cur = await seriesSvc.getSeries(s.id);
    const out = await planner.commitSeasonsWithRemap(cur, { arc: DRAFT_ARC, seasons: [] });
    expect(out.series.seasons.map((x) => x.id)).not.toContain(dropped.id);
  });
});

// Non-destructive guarantee behind the autopilot's unlock-for-run mode: once
// that pass clears the per-season locks, nothing else stops an LLM-proposed arc
// from deleting a volume — so the commit re-inserts dropped records while still
// applying content rewrites to the ones that survived.
describe('arcPlanner — preserveDroppedSeasonRecords', () => {
  const { preserveDroppedSeasonRecords } = planner.__testing;

  it('re-appends a dropped season without freezing the ones that survived', () => {
    const current = [{ id: 'sea-a', number: 1, title: 'Drop me' }, { id: 'sea-b', number: 2, title: 'Old' }];
    const next = [{ id: 'sea-b', number: 2, title: 'Rewritten' }];
    const merged = preserveDroppedSeasonRecords(current, next);
    expect(merged).toHaveLength(2);
    expect(merged.find((s) => s.id === 'sea-b').title).toBe('Rewritten');
    expect(merged.find((s) => s.id === 'sea-a')).toBe(current[0]);
  });

  it('returns next untouched when nothing was dropped', () => {
    const current = [{ id: 'sea-a', number: 1 }];
    const next = [{ id: 'sea-a', number: 1, title: 'x' }];
    expect(preserveDroppedSeasonRecords(current, next)).toBe(next);
  });

  it('is a no-op for a missing/empty current list or a non-array next', () => {
    const next = [{ id: 'a' }];
    expect(preserveDroppedSeasonRecords([], next)).toBe(next);
    expect(preserveDroppedSeasonRecords(null, next)).toBe(next);
    expect(preserveDroppedSeasonRecords([{ id: 'a' }], null)).toBeNull();
  });
});

// The duplicate-volume divergence (2026-08-09): auto-resolve returned a
// rewritten Volume 1 without echoing its id, `preserveDroppedSeasons` re-inserted
// the original alongside the mint, and arc-verify filed "three records numbered
// 1" as a blocking finding — one MORE finding than the round started with, every
// round, until the autopilot paused for no net progress.
describe('arcPlanner — matchProposedSeasons', () => {
  const { matchProposedSeasons } = planner.__testing;
  const existing = [
    { id: 'sea-a', number: 1, title: 'Salt at the Root' },
    { id: 'sea-b', number: 2, title: 'Six Blocks Down' },
  ];

  it('matches an id-less rewrite to the existing record by title', () => {
    const matched = matchProposedSeasons(existing, [
      { number: 1, title: 'salt at the ROOT  ', synopsis: 'rewritten' },
    ]);
    expect(matched[0]).toBe(existing[0]);
  });

  it('matches by number when the title was rewritten too', () => {
    const matched = matchProposedSeasons(existing, [{ number: 2, title: 'A New Name' }]);
    expect(matched[0]).toBe(existing[1]);
  });

  it('lets an id-carrying proposal win its own record over a same-titled sibling', () => {
    // Greedy single-pass matching would let the title-only proposal claim
    // sea-a first, forcing the id-carrying one to mint a duplicate.
    const matched = matchProposedSeasons(existing, [
      { number: 1, title: 'Salt at the Root' },
      { id: 'sea-a', number: 1, title: 'Salt at the Root' },
    ]);
    expect(matched[1]).toBe(existing[0]);
    expect(matched[0]).toBeNull();
  });

  it('leaves a genuinely new volume unmatched so it mints', () => {
    expect(matchProposedSeasons(existing, [{ number: 3, title: 'Brand New' }])).toEqual([null]);
  });

  it('refuses an ambiguous number match', () => {
    const dupes = [
      { id: 'sea-a', number: 1, title: 'One' },
      { id: 'sea-b', number: 1, title: 'Two' },
    ];
    expect(matchProposedSeasons(dupes, [{ number: 1, title: 'Neither' }])).toEqual([null]);
  });

  it('tolerates missing/empty inputs', () => {
    expect(matchProposedSeasons(null, [{ number: 1 }])).toEqual([null]);
    expect(matchProposedSeasons(existing, null)).toEqual([]);
  });
});

describe('arcPlanner — collapseDuplicateSeasonNumbers', () => {
  const { collapseDuplicateSeasonNumbers, hasDuplicateSeasonNumbers } = planner.__testing;

  it('detects duplicate numbers', () => {
    expect(hasDuplicateSeasonNumbers([{ number: 1 }, { number: 2 }])).toBe(false);
    expect(hasDuplicateSeasonNumbers([{ number: 1 }, { number: 1 }])).toBe(true);
    expect(hasDuplicateSeasonNumbers(null)).toBe(false);
  });

  it('keeps the record holding the episodes and reports the absorbed ids', () => {
    // The live shape: the original carries the 12 episodes, the two mints are
    // newer and empty.
    const seasons = [
      { id: 'sea-orig', number: 1, title: 'V1', createdAt: '2026-05-11T00:00:00.000Z', updatedAt: '2026-05-11T00:00:00.000Z', synopsis: 'original', themes: ['t'] },
      { id: 'sea-dup1', number: 1, title: 'V1', createdAt: '2026-08-09T14:25:00.000Z', updatedAt: '2026-08-09T14:25:00.000Z', synopsis: 'rev a', themes: [] },
      { id: 'sea-dup2', number: 1, title: 'V1', createdAt: '2026-08-09T14:30:00.000Z', updatedAt: '2026-08-09T14:30:00.000Z', synopsis: 'rev b', themes: [] },
    ];
    const { seasons: out, absorbed } = collapseDuplicateSeasonNumbers(
      seasons,
      new Map([['sea-orig', 12]]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('sea-orig');
    expect(out[0].synopsis).toBe('original'); // never clobbered by a duplicate
    expect([...absorbed]).toEqual([['sea-dup1', 'sea-orig'], ['sea-dup2', 'sea-orig']]);
  });

  it('back-fills only fields the survivor left empty, newest duplicate first', () => {
    const seasons = [
      { id: 'sea-orig', number: 1, title: 'V1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', synopsis: '', endingHook: 'keep me', themes: [] },
      { id: 'sea-old', number: 1, title: 'V1', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z', synopsis: 'stale', endingHook: 'drop me', themes: ['old'] },
      { id: 'sea-new', number: 1, title: 'V1', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z', synopsis: 'freshest', endingHook: 'drop me too', themes: ['new'] },
    ];
    const { seasons: out } = collapseDuplicateSeasonNumbers(seasons, new Map([['sea-orig', 3]]));
    expect(out[0].id).toBe('sea-orig');
    expect(out[0].synopsis).toBe('freshest');
    expect(out[0].endingHook).toBe('keep me');
    expect(out[0].themes).toEqual(['new']);
  });

  it('prefers a locked record over a better-populated unlocked one', () => {
    const seasons = [
      { id: 'sea-loose', number: 1, title: 'V1', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'sea-locked', number: 1, title: 'V1', locked: true, createdAt: '2026-02-01T00:00:00.000Z' },
    ];
    const { seasons: out, absorbed } = collapseDuplicateSeasonNumbers(seasons, new Map([['sea-loose', 9]]));
    expect(out[0].id).toBe('sea-locked');
    expect(absorbed.get('sea-loose')).toBe('sea-locked');
  });

  it('leaves a group with two locked records intact rather than deleting a frozen volume', () => {
    const seasons = [
      { id: 'sea-l1', number: 1, title: 'V1', locked: true },
      { id: 'sea-l2', number: 1, title: 'V1', locked: true },
    ];
    const { seasons: out, absorbed } = collapseDuplicateSeasonNumbers(seasons, new Map());
    expect(out).toHaveLength(2);
    expect(absorbed.size).toBe(0);
  });

  it('leaves a clean list untouched and keeps number ordering', () => {
    const seasons = [{ id: 'b', number: 2 }, { id: 'a', number: 1 }];
    const { seasons: out, absorbed } = collapseDuplicateSeasonNumbers(seasons, new Map());
    expect(out.map((s) => s.id)).toEqual(['a', 'b']);
    expect(absorbed.size).toBe(0);
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
  it('fingerprints manuscript completeness context canonically and includes narrative references', () => {
    const initial = {
      manuscript: 'A short draft.',
      series: { premise: 'An alliance must hold.', name: 'Example' },
      arc: { summary: 'The alliance survives.' },
      existingCharactersJson: '[{"name":"Ari"}]',
    };
    const reordered = {
      existingCharactersJson: '[{"name":"Ari"}]',
      arc: { summary: 'The alliance survives.' },
      series: { name: 'Example', premise: 'An alliance must hold.' },
      manuscript: 'A short draft.',
    };

    expect(planner.completenessSourceHash(reordered)).toBe(planner.completenessSourceHash(initial));
    expect(planner.completenessSourceHash({
      ...initial,
      arc: { summary: 'The alliance shatters.' },
    })).not.toBe(planner.completenessSourceHash(initial));
  });

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

  it('shapeCompletenessFindings sets replacementStrategy (full-page for comic-structure, delta otherwise; trusts a valid explicit value)', () => {
    const { shapeCompletenessFindings } = planner.__testing;
    const out = shapeCompletenessFindings([
      { category: 'comic-structure', problem: 'page is prose', suggestion: 'Panel 1 …' },
      { category: 'missing-content', problem: 'no climax', suggestion: 'add one' },
      // explicit strategy wins when valid …
      { category: 'pacing', problem: 'rushed', replacementStrategy: 'full-page' },
      // … and an invalid one falls back to the category default.
      { category: 'comic-structure', problem: 'another page', replacementStrategy: 'bogus' },
    ]);
    expect(out[0].replacementStrategy).toBe('full-page'); // derived from category
    expect(out[1].replacementStrategy).toBe('delta'); // narrative default
    expect(out[2].replacementStrategy).toBe('full-page'); // explicit, valid
    expect(out[3].replacementStrategy).toBe('full-page'); // invalid → category default
  });

  it('shapeCompletenessFindings reads `replace` only in the with-edits pass (trimmed; absent → no key)', () => {
    const { shapeCompletenessFindings } = planner.__testing;
    const raw = [
      { category: 'missing-content', problem: 'abrupt', anchorQuote: 'She left.', replace: '  She left, but paused.  ' },
      { category: 'pacing', problem: 'no replace', anchorQuote: 'q' }, // model omitted replace
    ];
    // Findings-only pass ignores `replace` entirely.
    const findingsOnly = shapeCompletenessFindings(raw);
    expect(findingsOnly[0]).not.toHaveProperty('replace');
    // With-edits pass carries a trimmed `replace`; an absent one yields no key.
    const withEdits = shapeCompletenessFindings(raw, { withEdits: true });
    expect(withEdits[0].replace).toBe('She left, but paused.');
    expect(withEdits[1]).not.toHaveProperty('replace');
  });

  it('analyzeManuscriptCompleteness passes withEdits into the prompt ctx and shapes replace', async () => {
    const s = await setupSeries();
    await issuesSvc.createIssue({ seriesId: s.id, title: 'One', arcPosition: 1, stages: { prose: { output: 'The hero walked in. She left.', status: 'ready' } } });
    stageRunnerSpy = vi.fn(async (template, ctx) => {
      expect(ctx.withEdits).toBe(true);
      return {
        content: { issues: [{ severity: 'high', category: 'arc-gap', issueNumber: 1, anchorQuote: 'She left.', problem: 'abrupt', suggestion: 'add a beat', replace: 'She left, but paused.' }] },
        runId: 'rc', providerId: 'p', model: 'm',
      };
    });
    const out = await planner.analyzeManuscriptCompleteness(s.id, { withEdits: true });
    expect(out.issues[0].replace).toBe('She left, but paused.');
    expect(out.issues[0].sourceContentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('analyzeManuscriptCompleteness defaults withEdits false (ctx.withEdits=false, no replace shaped)', async () => {
    const s = await setupSeries();
    await issuesSvc.createIssue({ seriesId: s.id, title: 'One', arcPosition: 1, stages: { prose: { output: 'A short draft.', status: 'ready' } } });
    stageRunnerSpy = vi.fn(async (template, ctx) => {
      expect(ctx.withEdits).toBe(false);
      return { content: { issues: [{ severity: 'low', category: 'pacing', problem: 'thin', replace: 'ignored' }] }, runId: 'rc', providerId: 'p', model: 'm' };
    });
    const out = await planner.analyzeManuscriptCompleteness(s.id);
    expect(out.issues[0]).not.toHaveProperty('replace');
  });

  it('capCanonReference caps combined canon size, trimming the largest block first', () => {
    const blocks = {
      objects: 'O'.repeat(10_000),
      characters: 'C'.repeat(4_000),
      places: 'P'.repeat(500),
    };
    const trimmed = planner.capCanonReference(blocks, 6_000);
    expect(trimmed).toBe(true);
    const total = Object.values(blocks).reduce((n, v) => n + v.length, 0);
    // Within budget (a small trim-marker allowance per cut block).
    expect(total).toBeLessThanOrEqual(6_200);
    // The smallest block survives untouched; the largest absorbed the cut.
    expect(blocks.places).toBe('P'.repeat(500));
    expect(blocks.objects.length).toBeLessThan(10_000);
  });

  it('capCanonReference is a no-op when already within budget', () => {
    const blocks = { a: 'x'.repeat(100), b: 'y'.repeat(100) };
    expect(planner.capCanonReference(blocks, 10_000)).toBe(false);
    expect(blocks.a).toBe('x'.repeat(100));
  });

  it('never feeds the LLM an empty manuscript on a constrained window (canon cannot starve the draft)', async () => {
    // Regression: an oversized canon/world context used to collapse usableChars
    // to 0 and slice the manuscript to '', so the model "reviewed" an empty
    // draft and reported the whole book missing. The canon cap + manuscript
    // floor must keep real script text in every chunk.
    const s = await setupSeries();
    const script = 'PAGE 1\nPANEL 1\nThe foundry hums. '.repeat(400); // ~13K chars of real script
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Act 1', arcPosition: 1, stages: { comicScript: { output: script, status: 'ready' } } });
    // Force a small planning window so the budgeter must chunk/trim.
    stageContextSpy = vi.fn(async () => ({ provider: { id: 'p' }, model: 'm', contextWindow: 32_768 }));
    const seen = [];
    stageRunnerSpy = vi.fn(async (template, ctx) => {
      seen.push(ctx.manuscript || '');
      return { content: { issues: [] }, runId: 'rc', providerId: 'p', model: 'm' };
    });
    await planner.analyzeManuscriptCompleteness(s.id, { withEdits: true });
    expect(seen.length).toBeGreaterThan(0);
    // Every chunk the model saw must carry real manuscript text — never ''.
    expect(seen.every((m) => m && m.trim().length > 0)).toBe(true);
    expect(seen.some((m) => m.includes('The foundry hums'))).toBe(true);
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

// Pure helpers extracted in #1544 to dedup the season-tree grouping (shared by
// buildVerifyContext + buildBeatTree) and the episode-match logic (shared by
// applyEpisodeResolutions + applyBeatResolutions). No I/O — tested directly.
describe('arcPlanner — groupIssuesBySeasonTree (#1544)', () => {
  const seasons = [
    { id: 's1', number: 1, title: 'One' },
    { id: 's2', number: 2, title: 'Two' },
  ];
  // Deliberately out of arcPosition order to prove the per-bucket sort.
  const issues = [
    { id: 'b', number: 2, seasonId: 's1', arcPosition: 2 },
    { id: 'a', number: 1, seasonId: 's1', arcPosition: 1 },
    { id: 'c', number: 3, seasonId: 's2', arcPosition: 1 },
    { id: 'u', number: 9, seasonId: null, arcPosition: 1 },
  ];
  const opts = {
    renderLeaf: (iss) => ({ number: iss.number }),
    seasonFields: (s) => ({ number: s.number, title: s.title }),
  };

  it('buckets by seasonId and sorts each bucket by arcPosition', () => {
    const tree = planner.groupIssuesBySeasonTree(seasons, issues, opts);
    expect(tree[0]).toMatchObject({ number: 1, title: 'One' });
    expect(tree[0].episodes.map((e) => e.number)).toEqual([1, 2]); // arcPosition order, not input order
    expect(tree[1].episodes.map((e) => e.number)).toEqual([3]);
  });

  it('appends a null-seasonId bucket as the (ungrouped issues) node', () => {
    const tree = planner.groupIssuesBySeasonTree(seasons, issues, opts);
    const ungrouped = tree[tree.length - 1];
    expect(ungrouped).toMatchObject({ number: null, title: '(ungrouped issues)' });
    expect(ungrouped.episodes.map((e) => e.number)).toEqual([9]);
  });

  it('omits the ungrouped node when every issue has a season', () => {
    const grouped = issues.filter((i) => i.seasonId);
    const tree = planner.groupIssuesBySeasonTree(seasons, grouped, opts);
    expect(tree.some((n) => n.title === '(ungrouped issues)')).toBe(false);
  });

  it('uses seasonFields for node shape and appends episodes last (key order)', () => {
    const tree = planner.groupIssuesBySeasonTree(
      [{ id: 's1', number: 1, title: 'One', status: 'active' }],
      [],
      { renderLeaf: opts.renderLeaf, seasonFields: (s) => ({ number: s.number, title: s.title, status: s.status }) },
    );
    expect(Object.keys(tree[0])).toEqual(['number', 'title', 'status', 'episodes']);
  });
});

describe('arcPlanner — matchIssueForEpisodeEdit (#1544)', () => {
  const issues = [
    { id: 'a', number: 5, seasonId: 's1' },
    { id: 'b', number: 5, seasonId: 's2' },
    { id: 'c', number: 7, seasonId: 's1' },
  ];
  const seasonIdByNumber = new Map([[1, 's1'], [2, 's2']]);

  it('requires the season match when the named season resolves', () => {
    const m = planner.matchIssueForEpisodeEdit(issues, seasonIdByNumber, { seasonNumber: 2, episodeNumber: 5 });
    expect(m?.id).toBe('b'); // not the global-first issue 5 (id 'a')
  });

  it('returns undefined (no number fallback) when the resolved season has no such issue', () => {
    const m = planner.matchIssueForEpisodeEdit(issues, seasonIdByNumber, { seasonNumber: 1, episodeNumber: 99 });
    expect(m).toBeUndefined();
  });

  it('matches on series-global number when no season is given', () => {
    const m = planner.matchIssueForEpisodeEdit(issues, seasonIdByNumber, { episodeNumber: 7 });
    expect(m?.id).toBe('c');
  });

  it('matches on number alone when the named season does not resolve', () => {
    const m = planner.matchIssueForEpisodeEdit(issues, seasonIdByNumber, { seasonNumber: 99, episodeNumber: 5 });
    expect(m?.id).toBe('a'); // first issue with number 5
  });
});

describe('arcPlanner — seasonIdByNumberOf (#1544)', () => {
  it('indexes only integer-numbered seasons', () => {
    const map = planner.seasonIdByNumberOf({
      seasons: [
        { id: 's1', number: 1 },
        { id: 's2', number: 2 },
        { id: 'bad', number: null },
        { id: 'bad2' },
      ],
    });
    expect([...map.entries()]).toEqual([[1, 's1'], [2, 's2']]);
  });

  it('returns an empty map for a seasonless series', () => {
    expect(planner.seasonIdByNumberOf({}).size).toBe(0);
    expect(planner.seasonIdByNumberOf(null).size).toBe(0);
  });
});
