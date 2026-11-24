import { describe, it, expect, vi } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

const fileStore = new Map();

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
vi.mock('../stageRunner.js', () => ({
  runStagedLLM: vi.fn(),
  extractJson: (raw) => JSON.parse(raw),
  // Large window so completeness runs as a single call (mode: 'whole').
  resolveStageContext: vi.fn(() => Promise.resolve({ provider: { id: 'p' }, model: 'm', contextWindow: 1_000_000 })),
}));

const planner = await import('./arcPlanner.js');


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
