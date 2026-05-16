import { describe, it, expect, vi, beforeEach } from 'vitest';

const fileStore = new Map();
let stageRunnerSpy;

vi.mock('../../lib/fileUtils.js', () => ({
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

// Stub the staged-LLM runner so the test owns the LLM response shape.
// Each test sets `stageRunnerSpy = vi.fn(...)` to control what comes back.
vi.mock('../../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn((...args) => stageRunnerSpy(...args)),
  extractJson: (raw) => JSON.parse(raw),
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
        characters: { variations: [
          { label: 'Mira Holt', prompt: 'field detective' },
        ] },
      },
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
    expect(ctx.worldCategoriesText).toContain('Mira Holt');
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
});
