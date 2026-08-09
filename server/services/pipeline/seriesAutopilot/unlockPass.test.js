import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createTempDataRoot,
  makePathsProxy,
  mockNoPeerSync,
  mockNoPeers,
} from '../../../lib/mockPathsDataRoot.js';

// File-backed store (same idiom as seriesAutopilot.test.js) so the REAL
// series/issues services run against an in-memory map, not Postgres. Partial
// mock — this suite loads `./session.js` transitively (for `broadcast`), which
// pulls in the cos/apps graph, and those modules read fileUtils members the
// autopilot itself never touches.
//
// PATHS.data is redirected at a temp dir too (#3683): the collection store
// behind `listSeries()` enumerates `PATHS.data/pipeline-series/` with a REAL
// readdir that the fileUtils overrides below never intercept, so on a populated
// checkout the developer's own series leaked into the fixture and broke the
// sole-universe ownership assertions. See the isolation probe at the bottom.
const tempRoot = createTempDataRoot('portos-unlock-pass-');
const fileStore = new Map();
vi.mock('../../../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: tempRoot,
  overrides: {
    tryReadFile: vi.fn().mockResolvedValue(null),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
    readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
  },
}));

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

vi.mock('../../instances.js', () => mockNoPeers());
vi.mock('../../sharing/peerSync.js', () => mockNoPeerSync());

// Stand-in universe record the pass reads + writes through the mutator form.
let universe = null;
const getUniverse = vi.fn(async (id) => (universe?.id === id ? universe : null));
const updateUniverse = vi.fn(async (id, patchOrMutator) => {
  const patch = typeof patchOrMutator === 'function' ? await patchOrMutator(universe) : patchOrMutator;
  if (!patch) return universe;
  universe = { ...universe, ...patch };
  return universe;
});
// Partial mock — other modules in the transitive graph import constants off the
// real barrel; only the two functions this pass uses are replaced.
vi.mock('../../universeBuilder.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUniverse: (...a) => getUniverse(...a),
  updateUniverse: (...a) => updateUniverse(...a),
}));

const seriesSvc = await import('../series.js');
const issuesSvc = await import('../issues.js');
const { isSeriesScopedCanonEntry } = await import('../../../lib/storyBible.js');
const { unlockSeriesForAutopilot, countSeriesLocks } = await import('./unlockPass.js');

const charEntry = (over = {}) => ({ id: 'c1', name: 'Kai', physicalDescription: 'Tall.', ...over });

beforeEach(() => {
  fileStore.clear();
  uuidCounter = 0;
  universe = null;
  getUniverse.mockClear();
  updateUniverse.mockClear();
});

describe('unlockPass — series-scoped canon predicate', () => {
  it('unlocks an entry this series minted, when it is the universe\'s only series', () => {
    expect(isSeriesScopedCanonEntry(charEntry({ sourceSeriesId: 's1' }), { seriesId: 's1', soleSeries: true })).toBe(true);
  });

  // `sourceSeriesId` is PROVENANCE, not exclusivity — every linked series can
  // reference any canon entry, so "s1 minted it" does not make it s1's alone.
  it('refuses even an entry this series minted once a sibling series shares the universe', () => {
    expect(isSeriesScopedCanonEntry(charEntry({ sourceSeriesId: 's1' }), { seriesId: 's1', soleSeries: false })).toBe(false);
  });

  it('refuses an entry another series minted, even when this series is the only one left linked', () => {
    expect(isSeriesScopedCanonEntry(charEntry({ sourceSeriesId: 's2' }), { seriesId: 's1', soleSeries: true })).toBe(false);
  });

  it('unlocks an unowned entry ONLY when this series is the universe\'s only series', () => {
    const unowned = charEntry();
    expect(isSeriesScopedCanonEntry(unowned, { seriesId: 's1', soleSeries: true })).toBe(true);
    expect(isSeriesScopedCanonEntry(unowned, { seriesId: 's1', soleSeries: false })).toBe(false);
  });

});

// The dry-run plan promises this number; the pass clears exactly these locks.
// One definition, so the two can't drift when a lock surface is added.
describe('unlockPass — countSeriesLocks', () => {
  it('counts the arc freeze, each arc field, each volume and each issue stage', () => {
    const series = {
      locked: { arc: true, arcFields: { logline: true, themes: true } },
      seasons: [{ id: 'a', locked: true }, { id: 'b' }],
    };
    const issues = [
      { stages: { idea: { locked: true }, prose: { locked: false }, comicPages: { locked: true } } },
      { stages: { idea: {} } },
    ];
    expect(countSeriesLocks(series, issues)).toBe(1 + 2 + 1 + 2);
  });

  it('is 0 for a fully-unlocked series and tolerates missing shapes', () => {
    expect(countSeriesLocks({ seasons: [{ id: 'a' }] }, [{ stages: {} }])).toBe(0);
    expect(countSeriesLocks(null, null)).toBe(0);
  });
});

describe('unlockPass — end-to-end over the real series/issue services', () => {
  const buildSeries = async ({ universeId = null } = {}) => {
    const s = await seriesSvc.createSeries({ name: 'Test Series', targetFormat: 'comic' });
    if (universeId) await seriesSvc.updateSeries(s.id, { universeId });
    return seriesSvc.getSeries(s.id);
  };

  it('clears the arc freeze, every arc-field lock, every volume lock and every stage lock', async () => {
    const s = await buildSeries();
    const seasons = [
      { id: 'sea-a', number: 1, title: 'One', locked: true },
      { id: 'sea-b', number: 2, title: 'Two', locked: false },
    ];
    await seriesSvc.updateSeries(s.id, {
      seasons,
      arc: { logline: 'L', summary: 'S' },
      locked: { arc: true, arcFields: { logline: true, themes: true } },
    });
    const issue = await issuesSvc.createIssue({ seriesId: s.id, title: 'I1' });
    await issuesSvc.updateStage(issue.id, 'idea', { locked: true });
    await issuesSvc.updateStage(issue.id, 'comicScript', { locked: true });
    // Visual stages carry the same lock bit and gate their own enqueue paths —
    // the sweep must cover every STAGE_ID, not just the text ones.
    await issuesSvc.updateStage(issue.id, 'comicPages', { locked: true });

    const counts = await unlockSeriesForAutopilot(s.id);
    expect(counts).toMatchObject({ arc: 1, arcFields: 2, seasons: 1, stages: 3, canon: 0 });

    const after = await seriesSvc.getSeries(s.id);
    expect(after.locked).toEqual({});
    expect(after.seasons.every((x) => x.locked !== true)).toBe(true);
    // Volume content survives the unlock — the pass only clears the lock bit.
    expect(after.seasons.find((x) => x.id === 'sea-a').title).toBe('One');
    const afterIssue = await issuesSvc.getIssue(issue.id);
    expect(afterIssue.stages.idea.locked).toBe(false);
    expect(afterIssue.stages.comicScript.locked).toBe(false);
    expect(afterIssue.stages.comicPages.locked).toBe(false);
  });

  it('is idempotent — a second pass finds nothing locked and reports zero', async () => {
    const s = await buildSeries();
    await seriesSvc.updateSeries(s.id, { locked: { arc: true } });
    await unlockSeriesForAutopilot(s.id);
    const second = await unlockSeriesForAutopilot(s.id);
    expect(second).toMatchObject({ arc: 0, arcFields: 0, seasons: 0, stages: 0, canon: 0 });
  });

  it('unlocks only the canon this series owns and keeps another series\' canon frozen', async () => {
    const mine = await buildSeries({ universeId: 'uni-1' });
    const other = await seriesSvc.createSeries({ name: 'Sibling', targetFormat: 'comic' });
    await seriesSvc.updateSeries(other.id, { universeId: 'uni-1' });
    universe = {
      id: 'uni-1',
      characters: [
        charEntry({ id: 'mine', locked: true, sourceSeriesId: mine.id }),
        charEntry({ id: 'theirs', locked: true, sourceSeriesId: other.id }),
        charEntry({ id: 'shared', locked: true }), // unowned + a sibling series exists
      ],
      places: [charEntry({ id: 'p1', locked: true, sourceSeriesId: mine.id })],
      objects: [],
    };

    const counts = await unlockSeriesForAutopilot(mine.id);
    // A sibling series shares the universe, so NOTHING is unlocked — not even
    // the entries this series minted. `sourceSeriesId` is provenance, not
    // exclusivity: the sibling can be built on 'mine' just as easily.
    expect(counts.canon).toBe(0);
    expect(counts.canonForeignKept).toBe(4);
    const byId = Object.fromEntries(universe.characters.map((e) => [e.id, e]));
    expect(byId.mine.locked).toBe(true);
    expect(byId.theirs.locked).toBe(true);
    expect(byId.shared.locked).toBe(true);
    expect(universe.places[0].locked).toBe(true);
    // Never destructive: every entry is still present in the universe.
    expect(universe.characters).toHaveLength(3);
    expect(universe.places).toHaveLength(1);
  });

  it('unlocks the canon this series minted once it is the universe\'s only series', async () => {
    const mine = await buildSeries({ universeId: 'uni-solo' });
    universe = {
      id: 'uni-solo',
      characters: [
        charEntry({ id: 'mine', locked: true, sourceSeriesId: mine.id }),
        // A stale stamp pointing at a series that is no longer linked is still
        // not a licence to unfreeze — sole-series is necessary, not sufficient.
        charEntry({ id: 'stale', locked: true, sourceSeriesId: 'ser-long-gone' }),
      ],
      places: [], objects: [],
    };
    const counts = await unlockSeriesForAutopilot(mine.id);
    expect(counts).toMatchObject({ canon: 1, canonForeignKept: 1 });
    const byId = Object.fromEntries(universe.characters.map((e) => [e.id, e]));
    expect(byId.mine.locked).toBe(false);
    expect(byId.stale.locked).toBe(true);
  });

  // Fails CLOSED: a listSeries() that throws must never read as "no siblings".
  it('keeps universe locks frozen when the sole-series lookup fails', async () => {
    const mine = await buildSeries({ universeId: 'uni-solo' });
    universe = {
      id: 'uni-solo',
      characters: [charEntry({ id: 'mine', locked: true, sourceSeriesId: mine.id })],
      places: [], objects: [],
      locked: { logline: true },
    };
    const spy = vi.spyOn(seriesSvc, 'listSeries').mockRejectedValueOnce(new Error('db down'));
    const counts = await unlockSeriesForAutopilot(mine.id);
    spy.mockRestore();
    expect(counts).toMatchObject({ canon: 0, worldFields: 0, worldFieldsKept: 1 });
    expect(universe.characters[0].locked).toBe(true);
    expect(universe.locked).toEqual({ logline: true });
  });

  // A rejecting scope must not make the report claim nothing was unlocked while
  // another scope has already permanently cleared its locks.
  it('reports the scopes that succeeded when another scope throws', async () => {
    const s = await buildSeries({ universeId: 'uni-boom' });
    await seriesSvc.updateSeries(s.id, { locked: { arc: true } });
    universe = null; // getUniverse resolves null -> universe scope is a clean zero
    const spy = vi.spyOn(issuesSvc, 'updateStagesWithLatest').mockRejectedValueOnce(new Error('stale issue'));
    const issue = await issuesSvc.createIssue({ seriesId: s.id, title: 'I1' });
    await issuesSvc.updateStage(issue.id, 'idea', { locked: true });
    const counts = await unlockSeriesForAutopilot(s.id);
    spy.mockRestore();
    // The series record really was unlocked — say so, instead of reporting a
    // blanket failure that would leave the run lying about its own state.
    expect(counts.arc).toBe(1);
    expect(counts.stages).toBe(0);
    expect(counts.failures).toHaveLength(1);
    expect(counts.failures[0]).toContain('issue stages');
    expect((await seriesSvc.getSeries(s.id)).locked).toEqual({});
  });

  it('unlocks unowned canon when this series is the universe\'s only series', async () => {
    const mine = await buildSeries({ universeId: 'uni-solo' });
    universe = { id: 'uni-solo', characters: [charEntry({ id: 'legacy', locked: true })], places: [], objects: [] };
    const counts = await unlockSeriesForAutopilot(mine.id);
    expect(counts.canon).toBe(1);
    expect(counts.canonForeignKept).toBe(0);
    expect(universe.characters[0].locked).toBe(false);
  });

  it('skips the universe read entirely for an orphan series (no universeId)', async () => {
    const s = await buildSeries();
    const counts = await unlockSeriesForAutopilot(s.id);
    expect(counts.canon).toBe(0);
    expect(counts.worldFields).toBe(0);
    expect(getUniverse).not.toHaveBeenCalled();
  });

  // The foundation gate's world + craft fixes report "every refinable world
  // field is locked" and pause the run — the exact stall this option removes.
  it('clears the universe world-field locks when this series is its only series', async () => {
    const mine = await buildSeries({ universeId: 'uni-solo' });
    universe = {
      id: 'uni-solo', characters: [], places: [], objects: [],
      locked: { logline: true, styleNotes: true },
    };
    const counts = await unlockSeriesForAutopilot(mine.id);
    expect(counts.worldFields).toBe(2);
    expect(counts.worldFieldsKept).toBe(0);
    expect(universe.locked).toEqual({});
  });

  // Canon locks and world-field locks live on the SAME record, so they must go
  // out as one patch — a second updateUniverse would re-read/re-sanitize the
  // whole universe and emit a second peer-sync recordUpdated for one action.
  it('clears owned canon and the world fields in a SINGLE universe write', async () => {
    const mine = await buildSeries({ universeId: 'uni-solo' });
    universe = {
      id: 'uni-solo',
      characters: [charEntry({ id: 'mine', locked: true, sourceSeriesId: mine.id })],
      places: [], objects: [],
      locked: { logline: true },
    };
    const counts = await unlockSeriesForAutopilot(mine.id);
    expect(counts).toMatchObject({ canon: 1, worldFields: 1, worldFieldsKept: 0 });
    expect(universe.characters[0].locked).toBe(false);
    expect(universe.locked).toEqual({});
    expect(updateUniverse).toHaveBeenCalledTimes(1);
  });

  it('leaves the universe world-field locks alone when a sibling series shares the universe', async () => {
    const mine = await buildSeries({ universeId: 'uni-1' });
    const other = await seriesSvc.createSeries({ name: 'Sibling', targetFormat: 'comic' });
    await seriesSvc.updateSeries(other.id, { universeId: 'uni-1' });
    universe = { id: 'uni-1', characters: [], places: [], objects: [], locked: { logline: true } };
    const counts = await unlockSeriesForAutopilot(mine.id);
    expect(counts.worldFields).toBe(0);
    expect(counts.worldFieldsKept).toBe(1);
    expect(universe.locked).toEqual({ logline: true });
  });

  it('writes nothing to the universe when no owned canon entry is locked', async () => {
    const mine = await buildSeries({ universeId: 'uni-1' });
    universe = { id: 'uni-1', characters: [charEntry({ id: 'mine', sourceSeriesId: mine.id })], places: [], objects: [] };
    await unlockSeriesForAutopilot(mine.id);
    // The mutator still runs (that is how the freshest state is read), but it
    // must return null so updateUniverse short-circuits with no write.
    expect(universe.characters[0].locked).toBeUndefined();
  });
});

// Isolation probe for #3683. The end-to-end suite above reaches `listSeries()`,
// which enumerates PATHS.data/pipeline-series with a REAL readdir — the fileUtils
// overrides do not intercept it. Before the PATHS redirect, the suite therefore
// saw the developer's own series and two sole-universe assertions failed on any
// checkout with a populated data/. These assertions fail the same way if the
// redirect is ever dropped, so the leak can't come back silently.
describe('unlockPass — the suite is isolated from the checkout\'s real data/', () => {
  it('resolves PATHS.data to a temp dir outside the repo', async () => {
    const { PATHS } = await import('../../../lib/fileUtils.js');
    expect(PATHS.data).toBe(tempRoot);
    expect(PATHS.data).not.toContain('PortOS');
  });

  it('anchors the series record directory under the temp root', () => {
    expect(seriesSvc.seriesStore().recordDir('ser-probe')).toBe(join(tempRoot, 'pipeline-series', 'ser-probe'));
  });

  // The behavioral half: `listSeries()` must return the suite's own fixtures and
  // nothing else. The store enumerates with a real `readdir` and only falls back
  // to its in-process id set when the collection dir is ABSENT — so a real
  // data/pipeline-series takes over the moment PATHS.data points at the
  // checkout, replacing the fixtures with the developer's series.
  it('lists only the series this suite created', async () => {
    const mine = await seriesSvc.createSeries({ name: 'Isolation Probe', targetFormat: 'comic' });
    const listed = await seriesSvc.listSeries();
    expect(listed.map((s) => s.id)).toEqual([mine.id]);
  });
});

// Source-level guard, not a behavioral one: unlocking is what lets the autopilot
// FULLY EDIT a character/object/volume, and the standing rule is that it must
// never turn into permission to DELETE one. A record that has to leave is a
// catalog archive (soft-delete/tombstone) performed by a human. Nothing in the
// conductor calls a destructive service today; this fails the moment something
// does, so the decision is made deliberately rather than by an innocent import.
describe('unlockPass — the conductor has no destructive canon/record path', () => {
  const DIR = dirname(fileURLToPath(import.meta.url));
  const DESTRUCTIVE = ['removeCanonEntry', 'deleteSeason', 'deleteIssue', 'deleteSeries', 'deleteUniverse'];
  const sources = readdirSync(DIR)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .map((f) => [f, readFileSync(join(DIR, f), 'utf8')]);

  it('reads every conductor module (guard would pass vacuously on an empty list)', () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it.each(DESTRUCTIVE)('never calls %s', (fn) => {
    // Match a CALL (`fn(`), not a mention — the module headers name these
    // deliberately when explaining the policy, and prose must not fail the guard.
    const callSite = new RegExp(`\\b${fn}\\s*\\(`);
    const offenders = sources.filter(([, src]) => callSite.test(src)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it('the guard actually detects a call (bypass probe)', () => {
    const callSite = new RegExp('\\bremoveCanonEntry\\s*\\(');
    expect(callSite.test('await removeCanonEntry(universeId, kind, id);')).toBe(true);
    expect(callSite.test('// removeCanonEntry is deliberately never used here')).toBe(false);
  });
});
