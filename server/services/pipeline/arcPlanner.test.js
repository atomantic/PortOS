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
