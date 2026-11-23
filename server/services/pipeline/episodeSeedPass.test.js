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
