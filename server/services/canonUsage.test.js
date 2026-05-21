import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the three collaborators canonUsage pulls from — universe storage, the
// series store, and the issue store. Each test seeds the fixtures directly
// so the assertions are deterministic without hitting disk.
const mockUniverses = new Map();
const mockSeriesList = [];
const mockIssuesBySeries = new Map();

vi.mock('./universeBuilder.js', () => ({
  ERR_NOT_FOUND: 'NOT_FOUND',
  getUniverse: vi.fn(async (id) => {
    const u = mockUniverses.get(id);
    if (!u) throw Object.assign(new Error(`Universe not found: ${id}`), { code: 'NOT_FOUND' });
    return u;
  }),
}));

vi.mock('./pipeline/series.js', () => ({
  listSeries: vi.fn(async () => [...mockSeriesList]),
}));

vi.mock('./pipeline/issues.js', () => ({
  listIssues: vi.fn(async ({ seriesId }) => mockIssuesBySeries.get(seriesId) || []),
}));

const { listIssues } = await import('./pipeline/issues.js');
const { getUniverseCanonUsage, listLinkedSeriesNames } = await import('./canonUsage.js');

beforeEach(() => {
  mockUniverses.clear();
  mockSeriesList.length = 0;
  mockIssuesBySeries.clear();
});

describe('canonUsage — seriesNameMap', () => {
  it('includes every linked series, even ones with no prose match', async () => {
    mockUniverses.set('uni-1', {
      id: 'uni-1',
      characters: [{ id: 'char-1', name: 'Lyra', sourceSeriesId: 'ser-quiet' }],
      settings: [],
      objects: [],
    });
    mockSeriesList.push(
      { id: 'ser-active', name: 'Phantom Pact', universeId: 'uni-1' },
      // Linked but has no issues / no prose match — must still appear in the
      // map so the CanonCard chip can render its name for entries stamped
      // with sourceSeriesId='ser-quiet'.
      { id: 'ser-quiet', name: 'Silent Series', universeId: 'uni-1' },
      // Different universe — must NOT leak into this universe's lookup.
      { id: 'ser-other', name: 'Other Universe', universeId: 'uni-2' },
    );
    mockIssuesBySeries.set('ser-active', [
      { id: 'iss-1', stages: { prose: { output: 'A long prose passage.' } } },
    ]);

    const usage = await getUniverseCanonUsage('uni-1');
    expect(usage.seriesNameMap).toEqual({
      'ser-active': 'Phantom Pact',
      'ser-quiet': 'Silent Series',
    });
    expect(usage.seriesCount).toBe(2);
  });

  it('returns an empty map when no series link to the universe', async () => {
    mockUniverses.set('uni-empty', { id: 'uni-empty', characters: [], settings: [], objects: [] });
    const usage = await getUniverseCanonUsage('uni-empty');
    expect(usage.seriesNameMap).toEqual({});
    expect(usage.seriesCount).toBe(0);
  });
});

describe('canonUsage — listLinkedSeriesNames', () => {
  it('returns only series linked to the requested universe as {id,name}', async () => {
    mockUniverses.set('uni-1', { id: 'uni-1', characters: [], settings: [], objects: [] });
    mockSeriesList.push(
      { id: 'ser-a', name: 'Alpha', universeId: 'uni-1' },
      { id: 'ser-b', name: 'Beta', universeId: 'uni-1' },
      // Different universe — must NOT appear in the result.
      { id: 'ser-c', name: 'Gamma', universeId: 'uni-other' },
    );
    // Seed issues to prove the thin variant skips the prose scan entirely —
    // the explicit listIssues assertion below is what locks that in; the
    // seeded data just ensures the assertion would catch a regression.
    mockIssuesBySeries.set('ser-a', [{ id: 'iss-1', stages: { prose: { output: 'long prose' } } }]);

    listIssues.mockClear();
    const result = await listLinkedSeriesNames('uni-1');
    expect(result).toEqual([
      { id: 'ser-a', name: 'Alpha' },
      { id: 'ser-b', name: 'Beta' },
    ]);
    // The thin endpoint must NOT scan issues — that's the whole point.
    expect(listIssues).not.toHaveBeenCalled();
  });

  it('returns an empty array when no series link to the universe', async () => {
    mockUniverses.set('uni-empty', { id: 'uni-empty', characters: [], settings: [], objects: [] });
    const result = await listLinkedSeriesNames('uni-empty');
    expect(result).toEqual([]);
  });

  it('throws 404 when the universe does not exist', async () => {
    await expect(listLinkedSeriesNames('missing'))
      .rejects.toMatchObject({ status: 404, code: 'UNIVERSE_NOT_FOUND' });
  });
});

describe('canonUsage — getUniverseCanonUsage entry rows', () => {
  it('throws 404 when the universe does not exist', async () => {
    await expect(getUniverseCanonUsage('missing'))
      .rejects.toMatchObject({ status: 404, code: 'UNIVERSE_NOT_FOUND' });
  });

  it('sorts per-entry rows by issueCount desc with alpha tiebreaker on seriesName', async () => {
    // Lyra appears in three series: 1 issue in "Zeta Tales", 1 in "Alpha Tales",
    // and 2 in "Beta Tales". Expected order: Beta (2) → Alpha (1) → Zeta (1).
    // Alpha vs Zeta lock the alpha-ascending tiebreaker at equal issueCount.
    mockUniverses.set('uni-1', {
      id: 'uni-1',
      characters: [{ id: 'char-lyra', name: 'Lyra' }],
      places: [],
      objects: [],
    });
    mockSeriesList.push(
      { id: 'ser-zeta', name: 'Zeta Tales', universeId: 'uni-1' },
      { id: 'ser-alpha', name: 'Alpha Tales', universeId: 'uni-1' },
      { id: 'ser-beta', name: 'Beta Tales', universeId: 'uni-1' },
    );
    mockIssuesBySeries.set('ser-zeta', [
      { id: 'iss-z1', stages: { prose: { output: 'Lyra walks home.' } } },
    ]);
    mockIssuesBySeries.set('ser-alpha', [
      { id: 'iss-a1', stages: { prose: { output: 'Lyra reads a book.' } } },
    ]);
    mockIssuesBySeries.set('ser-beta', [
      { id: 'iss-b1', stages: { prose: { output: 'Lyra fights.' } } },
      { id: 'iss-b2', stages: { prose: { output: 'Lyra rests.' } } },
    ]);

    const usage = await getUniverseCanonUsage('uni-1');
    expect(usage.characters['char-lyra']).toEqual([
      { seriesId: 'ser-beta', seriesName: 'Beta Tales', issueIds: ['iss-b1', 'iss-b2'], issueCount: 2 },
      { seriesId: 'ser-alpha', seriesName: 'Alpha Tales', issueIds: ['iss-a1'], issueCount: 1 },
      { seriesId: 'ser-zeta', seriesName: 'Zeta Tales', issueIds: ['iss-z1'], issueCount: 1 },
    ]);
    expect(usage.issueCount).toBe(4);
  });

  it('buckets matched entries under each kind\'s output key (characters/places/objects)', async () => {
    mockUniverses.set('uni-1', {
      id: 'uni-1',
      characters: [{ id: 'char-1', name: 'Lyra' }],
      places: [{ id: 'place-1', name: 'Thornwood' }],
      objects: [{ id: 'obj-1', name: 'Lantern' }],
    });
    mockSeriesList.push({ id: 'ser-1', name: 'Series One', universeId: 'uni-1' });
    mockIssuesBySeries.set('ser-1', [
      // One issue mentioning all three pins (a) that the iteration over
      // `Object.keys(MATCHERS)` covers all 3 kinds and (b) that each kind's
      // matches land in the correctly-named `usage[kind]` output bucket. A
      // refactor that dropped one of the three from the loop, or that wrote
      // `usage.locations` instead of `usage.places`, would fail here. (This
      // test does NOT verify the per-matcher *behavior* — alias-aware vs
      // name-only — because all three seeded names are unique to their kind;
      // matcher-function swaps would still pass. Behavior coverage belongs
      // in `scenePrompt.test.js` against the matchers directly.)
      { id: 'iss-1', stages: { prose: { output: 'Lyra walked through Thornwood holding a Lantern.' } } },
    ]);

    const usage = await getUniverseCanonUsage('uni-1');
    expect(usage.characters['char-1']).toEqual([
      { seriesId: 'ser-1', seriesName: 'Series One', issueIds: ['iss-1'], issueCount: 1 },
    ]);
    expect(usage.places['place-1']).toEqual([
      { seriesId: 'ser-1', seriesName: 'Series One', issueIds: ['iss-1'], issueCount: 1 },
    ]);
    expect(usage.objects['obj-1']).toEqual([
      { seriesId: 'ser-1', seriesName: 'Series One', issueIds: ['iss-1'], issueCount: 1 },
    ]);
  });

  it('counts empty/whitespace-corpus issues toward issueCount but excludes them from entry rows', async () => {
    mockUniverses.set('uni-1', {
      id: 'uni-1',
      characters: [{ id: 'char-1', name: 'Lyra' }],
      places: [],
      objects: [],
    });
    mockSeriesList.push({ id: 'ser-1', name: 'Series One', universeId: 'uni-1' });
    mockIssuesBySeries.set('ser-1', [
      { id: 'iss-blank', stages: {} },
      { id: 'iss-ws', stages: { prose: { output: '   \n  ' } } },
      { id: 'iss-real', stages: { prose: { output: 'Lyra was here.' } } },
    ]);

    const usage = await getUniverseCanonUsage('uni-1');
    // `issueCount` is "total issues scanned" per the JSDoc contract — skipped-
    // corpus issues still count toward it, only the matched issue contributes
    // to the per-entry rows below.
    expect(usage.issueCount).toBe(3);
    expect(usage.characters['char-1']).toEqual([
      { seriesId: 'ser-1', seriesName: 'Series One', issueIds: ['iss-real'], issueCount: 1 },
    ]);
  });

  it('aggregates corpus across every stage field corpusForIssue reads', async () => {
    // A character that only appears in one of the corpus fields must still
    // surface — that's the whole point of the multi-stage corpus assembly in
    // corpusForIssue(). Each character below is unique to exactly one of the
    // six fields the corpus pulls (prose.output, prose.input, idea.output,
    // idea.input, comicScript.output, teleplay.output); a refactor that drops
    // any one field from the list would lose that character and fail here.
    mockUniverses.set('uni-1', {
      id: 'uni-1',
      characters: [
        { id: 'char-prose-out', name: 'Proseou' },
        { id: 'char-prose-in', name: 'Prosein' },
        { id: 'char-idea-out', name: 'Ideaou' },
        { id: 'char-idea-in', name: 'Ideain' },
        { id: 'char-script', name: 'Scriptia' },
        { id: 'char-tele', name: 'Telepha' },
      ],
      places: [],
      objects: [],
    });
    mockSeriesList.push({ id: 'ser-1', name: 'Series One', universeId: 'uni-1' });
    mockIssuesBySeries.set('ser-1', [
      { id: 'iss-1', stages: { prose: { output: 'Proseou writes.' } } },
      { id: 'iss-2', stages: { prose: { input: 'Prosein outlines.' } } },
      { id: 'iss-3', stages: { idea: { output: 'Ideaou arrives.' } } },
      { id: 'iss-4', stages: { idea: { input: 'Ideain brainstorms.' } } },
      { id: 'iss-5', stages: { comicScript: { output: 'Scriptia speaks.' } } },
      { id: 'iss-6', stages: { teleplay: { output: 'Telepha exits.' } } },
    ]);

    const usage = await getUniverseCanonUsage('uni-1');
    expect(Object.keys(usage.characters).sort()).toEqual([
      'char-idea-in', 'char-idea-out', 'char-prose-in', 'char-prose-out', 'char-script', 'char-tele',
    ]);
  });

  it('returns empty buckets for kinds the universe defines no entries for', async () => {
    mockUniverses.set('uni-1', {
      id: 'uni-1',
      characters: [{ id: 'char-1', name: 'Lyra' }],
      // places + objects intentionally undefined to also pin the
      // `Array.isArray(...) ? ... : []` guard in canonUsage.js.
    });
    mockSeriesList.push({ id: 'ser-1', name: 'Series One', universeId: 'uni-1' });
    mockIssuesBySeries.set('ser-1', [
      { id: 'iss-1', stages: { prose: { output: 'Lyra appears.' } } },
    ]);

    const usage = await getUniverseCanonUsage('uni-1');
    expect(usage.characters['char-1']).toBeDefined();
    expect(usage.places).toEqual({});
    expect(usage.objects).toEqual({});
  });
});
