import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Each domain's stat getter is stubbed so the registry can be driven to its interesting
// states — populated, empty, not-applicable, and read-failure — without any of the real
// dependency graphs (Postgres, the universe store, the meatspace files) loading. Mirrors
// characterSkills.test.js, since both registries fan out over the same signal context.
const stats = vi.hoisted(() => ({
  universes: 0,
  works: 0,
  catalog: { total: 0, scraps: 0 },
  sessions: [],
  training: [],
  today: '2026-07-17',
  // Obviously-fake fixed timezone, well behind UTC, so a late-UTC instant lands on the previous
  // local day and daysActive's day-boundary normalization is observable.
  timezone: 'America/Los_Angeles',
  logging: { currentStreak: 0, totalLogged: 0, activeDayKeys: [] },
  goals: { goals: [] },
  memories: 0,
  assets: 0,
}));

// A domain "fails" by having its stub reject — the same way a real getter surfaces an
// unreachable Postgres or an unreadable data file.
const fail = (name) => () => Promise.reject(new Error(`${name} unavailable`));

vi.mock('./universeBuilder.js', () => ({ countUniverses: vi.fn(async () => stats.universes) }));
vi.mock('./writersRoom/local.js', () => ({ countWorks: vi.fn(async () => stats.works) }));
vi.mock('./catalogDB.js', () => ({ getCatalogStats: vi.fn(async () => stats.catalog) }));
vi.mock('./meatspacePost.js', () => ({ getPostSessions: vi.fn(async () => stats.sessions) }));
vi.mock('./meatspacePostTraining.js', () => ({ getAllTrainingEntries: vi.fn(async () => stats.training) }));
vi.mock('./meatspaceLoggingStats.js', () => ({ getLoggingStats: vi.fn(async () => stats.logging) }));
vi.mock('./identity/goals.js', () => ({ getGoals: vi.fn(async () => stats.goals) }));
vi.mock('./memoryBackend.js', () => ({ countMemories: vi.fn(async () => stats.memories) }));
vi.mock('./mediaAssetIndex/db.js', () => ({ countAssets: vi.fn(async () => stats.assets) }));
vi.mock('./instanceFeatures.js', () => ({
  isInstanceFeatureEnabled: vi.fn(async () => true),
}));
// PARTIAL mock: only the two settings-backed reads are stubbed. `todayInTimezone` must stay
// REAL — `lib/activeDays.js` (behind the daysActive tile) derives its day keys through it, and
// a factory that dropped it would leave that tile throwing on an undefined import and reading
// `unavailable` for reasons that have nothing to do with the behavior under test.
vi.mock('./userTimezone.js', async (importOriginal) => ({
  ...(await importOriginal()),
  userLocalToday: vi.fn(async () => stats.today),
  getUserTimezone: vi.fn(async () => stats.timezone),
}));

import { getCharacterMetrics, METRICS, METRIC_NOT_APPLICABLE } from './characterMetrics.js';
import { createSignalContext } from './characterSignals.js';
import { getCharacterSkills } from './characterSkills.js';
import { countUniverses } from './universeBuilder.js';
import { getCatalogStats } from './catalogDB.js';
import { getLoggingStats } from './meatspaceLoggingStats.js';
import { getGoals } from './identity/goals.js';
import { countMemories } from './memoryBackend.js';
import { countAssets } from './mediaAssetIndex/db.js';
import { countWorks } from './writersRoom/local.js';
import { getPostSessions } from './meatspacePost.js';
import { getAllTrainingEntries } from './meatspacePostTraining.js';
import { userLocalToday, getUserTimezone } from './userTimezone.js';
import { isInstanceFeatureEnabled } from './instanceFeatures.js';

const goal = (status) => ({ status });

// Restore every stat to the "brand new install" baseline between tests so a test that
// populates one domain can't leak into the next one's empty-domain assertions.
beforeEach(() => {
  stats.universes = 0;
  stats.works = 0;
  stats.catalog = { total: 0, scraps: 0 };
  stats.sessions = [];
  stats.training = [];
  stats.today = '2026-07-17';
  stats.timezone = 'America/Los_Angeles';
  stats.logging = { currentStreak: 0, totalLogged: 0, activeDayKeys: [] };
  stats.goals = { goals: [] };
  stats.memories = 0;
  stats.assets = 0;
  vi.mocked(countUniverses).mockImplementation(async () => stats.universes);
  vi.mocked(countWorks).mockImplementation(async () => stats.works);
  vi.mocked(getCatalogStats).mockImplementation(async () => stats.catalog);
  vi.mocked(getPostSessions).mockImplementation(async () => stats.sessions);
  vi.mocked(getLoggingStats).mockImplementation(async () => stats.logging);
  vi.mocked(getGoals).mockImplementation(async () => stats.goals);
  vi.mocked(countMemories).mockImplementation(async () => stats.memories);
  vi.mocked(countAssets).mockImplementation(async () => stats.assets);
  vi.mocked(getAllTrainingEntries).mockImplementation(async () => stats.training);
  vi.mocked(userLocalToday).mockImplementation(async () => stats.today);
  vi.mocked(getUserTimezone).mockImplementation(async () => stats.timezone);
  vi.mocked(isInstanceFeatureEnabled).mockResolvedValue(true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const byId = (metrics, id) => metrics.find((m) => m.id === id);

describe('getCharacterMetrics — disabled features', () => {
  it('omits POST metrics and POST activity reads when POST is disabled on this instance', async () => {
    isInstanceFeatureEnabled.mockResolvedValue(false);

    const metrics = await getCharacterMetrics();

    expect(byId(metrics, 'postStreakDays')).toBeUndefined();
    expect(getPostSessions).not.toHaveBeenCalled();
    expect(getAllTrainingEntries).not.toHaveBeenCalled();
  });
});

describe('the registry', () => {
  it('declares a unique id, label, unit, hint and compute for each metric', () => {
    const ids = new Set();
    for (const metric of METRICS) {
      expect(metric.id).toMatch(/^[a-zA-Z]+$/);
      expect(ids.has(metric.id)).toBe(false);
      ids.add(metric.id);
      expect(metric.label).toBeTruthy();
      expect(metric.hint).toBeTruthy();
      expect(['count', 'days', 'percent']).toContain(metric.unit);
      expect(typeof metric.compute).toBe('function');
    }
  });

  it('ships at least the three real metrics the acceptance criteria require', () => {
    expect(METRICS.length).toBeGreaterThanOrEqual(3);
  });

  it('contains a synchronously-thrown compute to its own tile rather than failing the whole read', async () => {
    // Every shipped compute is async, so a sync throw can only come from a future entry
    // declared without `async` — which must degrade ONE tile, not reject GET /api/character.
    const exploding = { id: 'boom', label: 'Boom', unit: 'count', hint: 'x', compute: () => { throw new Error('sync boom'); } };
    METRICS.push(exploding);
    try {
      const metrics = await getCharacterMetrics();
      expect(byId(metrics, 'boom')).toMatchObject({ value: null, unavailable: true });
      // ...and the real tiles still report.
      expect(byId(metrics, 'memoryCount').unavailable).toBe(false);
    } finally {
      METRICS.pop();
    }
  });

  it('declares an emptyLabel for every metric that can be not-applicable', async () => {
    // A ratio metric with no denominator renders its emptyLabel; shipping one without would
    // leave the tile saying a bare, meaningless "Not applicable yet".
    stats.goals = { goals: [] };
    const metrics = await getCharacterMetrics();
    for (const metric of metrics.filter((m) => m.notApplicable)) {
      expect(metric.emptyLabel).toBeTruthy();
    }
  });

  it('returns one uniform key set across all three states', async () => {
    // A consumer should never have to tell "absent key" apart from "null value" on top of the
    // three states themselves.
    stats.goals = { goals: [] };                // drives notApplicable
    vi.mocked(countMemories).mockImplementation(fail('memory backend')); // drives unavailable
    stats.assets = 5;                           // drives a real value

    const metrics = await getCharacterMetrics();
    const shape = ['emptyLabel', 'hint', 'id', 'label', 'notApplicable', 'unavailable', 'unit', 'value'];
    for (const metric of metrics) {
      expect(Object.keys(metric).sort()).toEqual(shape);
    }
  });
});

describe('getCharacterMetrics — empty domains', () => {
  it('reports a real, earned 0 for every countable metric on a fresh install', async () => {
    const metrics = await getCharacterMetrics();

    expect(metrics).toHaveLength(METRICS.length);
    // Every metric EXCEPT the ratio has a legitimate 0 answer; none of them are unavailable.
    // If a signal id were typo'd, its read would throw and this would go red — which is
    // exactly the guard that lets characterSignals.js throw rather than reject.
    for (const metric of metrics) {
      expect(metric.unavailable).toBe(false);
      if (!metric.notApplicable) expect(metric.value).toBe(0);
    }
  });

  it('distinguishes a real 0 from an unread stat', async () => {
    const memories = byId(await getCharacterMetrics(), 'memoryCount');
    expect(memories).toMatchObject({ value: 0, unavailable: false, notApplicable: false });
    expect(memories.value).not.toBeNull();
  });
});

describe('getCharacterMetrics — populated domains', () => {
  it('derives recordsCreated from universes + works + catalog entries + scraps', async () => {
    stats.universes = 3;
    stats.works = 2;
    stats.catalog = { total: 8, scraps: 2 };
    expect(byId(await getCharacterMetrics(), 'recordsCreated')).toMatchObject({
      value: 15, unit: 'count', unavailable: false,
    });
  });

  it('derives postStreakDays from the unified sessions-OR-training streak', async () => {
    // Three consecutive days ending today: one scored session, two training entries. The
    // unified streak counts a day active on EITHER, so this must be 3 and not 1.
    stats.sessions = [{ date: '2026-07-17' }];
    stats.training = [{ date: '2026-07-16' }, { date: '2026-07-15' }];
    expect(byId(await getCharacterMetrics(), 'postStreakDays')).toMatchObject({
      value: 3, unit: 'days', unavailable: false,
    });
  });

  it('anchors the POST streak to the USER timezone day, not the server clock', async () => {
    // Otherwise the sheet's streak could disagree with the Progress page's by a day.
    stats.today = '2026-07-17';
    stats.sessions = [{ date: '2026-07-17' }, { date: '2026-07-16' }];
    expect(byId(await getCharacterMetrics(), 'postStreakDays').value).toBe(2);

    // Same records, a user timezone already a day ahead: today is unlogged, but the grace
    // window keeps yesterday's run alive.
    stats.today = '2026-07-18';
    expect(byId(await getCharacterMetrics(), 'postStreakDays').value).toBe(2);
    expect(userLocalToday).toHaveBeenCalled();
  });

  it('re-keys legacy POST instants with the same timezone as Days Active', async () => {
    stats.today = '2026-07-18';
    stats.timezone = 'America/Los_Angeles';
    stats.training = [
      { date: '2026-07-17T09:00:00.000Z' },
      { date: '2026-07-18T02:00:00.000Z' },
    ];

    expect(byId(await getCharacterMetrics(), 'postStreakDays')).toMatchObject({
      value: 1, unavailable: false,
    });
  });

  it('reports a broken POST streak as a real 0, not as unavailable', async () => {
    stats.today = '2026-07-17';
    stats.sessions = [{ date: '2026-01-01' }]; // active once, long ago
    expect(byId(await getCharacterMetrics(), 'postStreakDays')).toMatchObject({
      value: 0, unavailable: false, notApplicable: false,
    });
  });

  it('derives healthLoggingStreak from the logging stats current streak', async () => {
    stats.logging = { currentStreak: 12, totalLogged: 40 };
    expect(byId(await getCharacterMetrics(), 'healthLoggingStreak')).toMatchObject({
      value: 12, unit: 'days', unavailable: false,
    });
  });

  it('derives memoryCount and mediaAssets from their tallies', async () => {
    stats.memories = 250;
    stats.assets = 31;
    const metrics = await getCharacterMetrics();
    expect(byId(metrics, 'memoryCount').value).toBe(250);
    expect(byId(metrics, 'mediaAssets').value).toBe(31);
  });

  it('does not claim the media tile counts only RENDERED media', async () => {
    // countAssets() is an unfiltered COUNT(*) over an index that deliberately holds downloads
    // and reconciled gallery uploads too, so the tile must not promise provenance it lacks.
    const media = byId(await getCharacterMetrics(), 'mediaAssets');
    expect(media.label).not.toMatch(/render/i);
    expect(media.hint).not.toMatch(/render/i);
  });

  it('does not claim the memory tile counts only BRAIN captures', async () => {
    // countMemories({}) filters on `status: 'active'` only — agent/CoS/API memories are all in
    // the tally, not just the `sourceAppId: 'brain'` ones.
    expect(byId(await getCharacterMetrics(), 'memoryCount').hint).not.toMatch(/brain/i);
  });
});

describe('getCharacterMetrics — daysActive (#4120)', () => {
  it('UNIONS day sets across domains — a day logged twice counts once', async () => {
    // The load-bearing property, and the reason this tile was cut from #2676 rather than
    // approximated: summing per-domain day counts would report 5 for three real days.
    stats.logging = { currentStreak: 0, totalLogged: 0, activeDayKeys: ['2026-03-12', '2026-03-14'] };
    stats.sessions = [{ date: '2026-03-14' }];
    stats.training = [{ date: '2026-03-14' }, { date: '2026-03-13' }];

    expect(byId(await getCharacterMetrics(), 'daysActive')).toMatchObject({
      value: 3, unit: 'days', unavailable: false, notApplicable: false,
    });
  });

  it('reports a real, earned 0 on an install with no activity anywhere', async () => {
    // 0 is the honest answer here — NOT unavailable, and not not-applicable.
    expect(byId(await getCharacterMetrics(), 'daysActive')).toMatchObject({
      value: 0, unavailable: false, notApplicable: false,
    });
  });

  it('counts a POST-only install without needing a health log', async () => {
    stats.sessions = [{ date: '2026-03-14' }, { date: '2026-03-15' }];
    expect(byId(await getCharacterMetrics(), 'daysActive').value).toBe(2);
  });

  it('normalizes the day boundary so the two domains agree on where a day starts', async () => {
    // A health entry stamped with the server-local (UTC) day, and a LEGACY training entry that
    // still stores a full ISO instant. Splitting that instant on 'T' yields the UTC day
    // 2026-03-15, so a naive union would report two days; in the user's timezone it is the
    // evening of 2026-03-14 — the same day the health entry is on. ONE day, not two.
    stats.logging = { currentStreak: 0, totalLogged: 0, activeDayKeys: ['2026-03-14'] };
    stats.training = [{ date: '2026-03-15T02:30:00.000Z' }];

    expect(byId(await getCharacterMetrics(), 'daysActive').value).toBe(1);
  });

  it('re-keys that instant against the USER timezone, not the server clock', async () => {
    // Same records, a user configured a day ahead of UTC: now the instant really is its own
    // local day, so the union grows to two. Pins that the timezone is actually consulted.
    stats.logging = { currentStreak: 0, totalLogged: 0, activeDayKeys: ['2026-03-14'] };
    stats.training = [{ date: '2026-03-14T18:00:00.000Z' }];

    expect(byId(await getCharacterMetrics(), 'daysActive').value).toBe(1);

    stats.timezone = 'Asia/Tokyo';
    expect(byId(await getCharacterMetrics(), 'daysActive').value).toBe(2);
    expect(getUserTimezone).toHaveBeenCalled();
  });

  it('is unavailable — never 0 — when the health-log day keys could not be read', async () => {
    // A shape that reports aggregates but no day keys is a FAILED read, not an idle install.
    // Rendering 0 for someone with years of history is the exact lie the sentinels prevent.
    stats.logging = { currentStreak: 9, totalLogged: 40 };
    stats.sessions = [{ date: '2026-03-14' }];

    const tile = byId(await getCharacterMetrics(), 'daysActive');
    expect(tile).toMatchObject({ value: null, unavailable: true, notApplicable: false });
    expect(tile.value).not.toBe(0);
  });

  it('is unavailable when a POST source is unreadable rather than under-counting', async () => {
    stats.logging = { currentStreak: 0, totalLogged: 0, activeDayKeys: ['2026-03-14'] };
    vi.mocked(getAllTrainingEntries).mockImplementation(fail('training log'));

    expect(byId(await getCharacterMetrics(), 'daysActive')).toMatchObject({
      value: null, unavailable: true,
    });
  });

  it('ignores entries with no usable date instead of counting them as a day', async () => {
    stats.logging = { currentStreak: 0, totalLogged: 0, activeDayKeys: ['2026-03-14'] };
    stats.sessions = [{}, { date: null }, { date: 'someday' }];

    expect(byId(await getCharacterMetrics(), 'daysActive').value).toBe(1);
  });

  it('reads the health-log day keys through the SHARED signal, adding no extra read', async () => {
    // The tile reuses the loggingStats signal healthLoggingStreak already reads, so it costs
    // nothing beyond the one settings read for the timezone.
    vi.mocked(getLoggingStats).mockClear();
    await getCharacterMetrics();
    expect(getLoggingStats).toHaveBeenCalledTimes(1);
    expect(getLoggingStats).toHaveBeenCalledWith({ strict: true, withActiveDayKeys: true });
  });
});

describe('getCharacterMetrics — goalCompletionRate', () => {
  it('is the completed share of ALL goals', async () => {
    stats.goals = { goals: [goal('completed'), goal('completed'), goal('active'), goal('active')] };
    expect(byId(await getCharacterMetrics(), 'goalCompletionRate')).toMatchObject({
      value: 50, unit: 'percent', unavailable: false, notApplicable: false,
    });
  });

  it('MOVES as goals are filed and completed — the reason the denominator is all goals', async () => {
    // Load-bearing: a resolved-only denominator (completed + abandoned) would be pinned at
    // 100% forever, because the Goals UI only ever writes `completed` (its other terminal
    // action deletes the record) and nothing in the client writes `abandoned`.
    stats.goals = { goals: [goal('completed')] };
    expect(byId(await getCharacterMetrics(), 'goalCompletionRate').value).toBe(100);

    stats.goals = { goals: [goal('completed'), goal('active'), goal('active'), goal('active')] };
    expect(byId(await getCharacterMetrics(), 'goalCompletionRate').value).toBe(25);
  });

  it('counts an abandoned goal in the denominator if one ever appears', async () => {
    // `abandoned` is in goalStatusEnum and the API honors it; no UI writes it today. When one
    // does, it should read as an un-completed goal, not vanish from the rate.
    stats.goals = { goals: [goal('completed'), goal('abandoned')] };
    expect(byId(await getCharacterMetrics(), 'goalCompletionRate').value).toBe(50);
  });

  it('reports a REAL 0% when goals exist but none are done', async () => {
    // Here 0 is the honest answer and must NOT be suppressed into the not-applicable state.
    stats.goals = { goals: [goal('active'), goal('active')] };
    expect(byId(await getCharacterMetrics(), 'goalCompletionRate')).toMatchObject({
      value: 0, notApplicable: false, unavailable: false,
    });
  });

  it('reports NOT APPLICABLE — never 0% — on an install with no goals at all', async () => {
    // The load-bearing case for the third state: "0% of your goals are done" is a lie to tell
    // someone who has never filed one.
    stats.goals = { goals: [] };
    const rate = byId(await getCharacterMetrics(), 'goalCompletionRate');
    expect(rate).toMatchObject({ value: null, unavailable: false, notApplicable: true });
    expect(rate.value).not.toBe(0);
    expect(rate.emptyLabel).toBeTruthy();
  });

  it('tolerates a goals payload with missing/odd entries', async () => {
    // Odd entries still count as un-completed goals rather than crashing.
    stats.goals = { goals: [null, undefined, {}, goal('completed')] };
    expect(byId(await getCharacterMetrics(), 'goalCompletionRate').value).toBe(25);
  });

  it('treats a goals payload with no goals array as not-applicable, not a crash', async () => {
    stats.goals = {};
    expect(byId(await getCharacterMetrics(), 'goalCompletionRate')).toMatchObject({
      notApplicable: true, unavailable: false,
    });
  });
});

// NOTE ON WHAT THIS SUITE PROVES: these tests drive failure by making a stubbed getter
// reject, which exercises readMetric's classification — the registry's own job. It does NOT
// prove the real wiring can reach `unavailable` for the file-backed signals (postSessions,
// postTraining, loggingStats, goals), which bottom out in readJSONFile and swallow read
// errors. That gap is real, documented in characterSignals.js / characterSkills.js, and
// tracked in #2726. Do not read a green run here as "every domain reports failures correctly".
describe('getCharacterMetrics — stat-read failure (must NOT collapse into a fake 0)', () => {
  it('marks a metric unavailable with a null value when its stat read rejects', async () => {
    vi.mocked(countMemories).mockImplementation(fail('memory backend'));

    const memories = byId(await getCharacterMetrics(), 'memoryCount');
    expect(memories.unavailable).toBe(true);
    // Null, not 0 — a 0 would read as "you have never saved a memory", which is a lie.
    expect(memories.value).toBeNull();
    expect(memories.value).not.toBe(0);
  });

  it('keeps unavailable DISTINCT from not-applicable', async () => {
    // Both render a dash, but they say different things ("we could not tell" vs "there is no
    // number yet") and the UI must be able to tell them apart.
    vi.mocked(getGoals).mockImplementation(fail('goals'));
    expect(byId(await getCharacterMetrics(), 'goalCompletionRate')).toMatchObject({
      value: null, unavailable: true, notApplicable: false,
    });
  });

  it('contains a failure to its own metric — other domains still report', async () => {
    stats.logging = { currentStreak: 5, totalLogged: 40 };
    vi.mocked(countMemories).mockImplementation(fail('memory backend'));

    const metrics = await getCharacterMetrics();
    expect(byId(metrics, 'memoryCount').unavailable).toBe(true);
    expect(byId(metrics, 'healthLoggingStreak')).toMatchObject({ value: 5, unavailable: false });
    expect(metrics).toHaveLength(METRICS.length);
  });

  it('never rejects, even when every domain is unreadable', async () => {
    vi.mocked(countUniverses).mockImplementation(fail('universe store'));
    vi.mocked(getCatalogStats).mockImplementation(fail('catalog'));
    vi.mocked(getLoggingStats).mockImplementation(fail('logging stats'));
    vi.mocked(getGoals).mockImplementation(fail('goals'));
    vi.mocked(countMemories).mockImplementation(fail('memory backend'));
    vi.mocked(countAssets).mockImplementation(fail('media index'));
    vi.mocked(getPostSessions).mockImplementation(fail('post sessions'));

    const metrics = await getCharacterMetrics();
    expect(metrics).toHaveLength(METRICS.length);
    for (const metric of metrics) {
      expect(metric).toMatchObject({ value: null, unavailable: true });
    }
  });

  it('marks a partially-failed multi-read metric unavailable rather than under-counting', async () => {
    // recordsCreated reads three stores. If only the catalog is down, reporting just the
    // universe count would silently understate it — "can't tell" is the honest answer.
    stats.universes = 3;
    vi.mocked(getCatalogStats).mockImplementation(fail('catalog'));

    expect(byId(await getCharacterMetrics(), 'recordsCreated')).toMatchObject({
      value: null, unavailable: true,
    });
  });

  it('treats a non-finite stat value as unavailable, not as 0', async () => {
    // A getter that resolves undefined/NaN is a broken read, not an idle domain. Note `null`
    // is in this list on purpose: a broken getter returning null must NOT be able to pass
    // itself off as the not-applicable state (which is a Symbol, not null).
    for (const broken of [undefined, null, NaN, Infinity, 'twelve']) {
      vi.mocked(countMemories).mockImplementation(async () => broken);
      expect(byId(await getCharacterMetrics(), 'memoryCount')).toMatchObject({
        value: null, unavailable: true, notApplicable: false,
      });
    }
  });

  it('treats a negative stat value as unavailable, not as 0', async () => {
    vi.mocked(countMemories).mockImplementation(async () => -3);
    expect(byId(await getCharacterMetrics(), 'memoryCount')).toMatchObject({
      value: null, unavailable: true,
    });
  });

  it('keeps id/label/unit/hint on an unavailable metric so the UI can still name it', async () => {
    vi.mocked(countMemories).mockImplementation(fail('memory backend'));
    expect(byId(await getCharacterMetrics(), 'memoryCount')).toMatchObject({
      id: 'memoryCount', label: 'Memories', unit: 'count', hint: 'Active memories across PortOS',
    });
  });

  it('never leaks a sentinel Symbol into the response payload', async () => {
    vi.mocked(countMemories).mockImplementation(fail('memory backend'));
    stats.goals = { goals: [] }; // drives the not-applicable path too
    for (const metric of await getCharacterMetrics()) {
      for (const value of Object.values(metric)) {
        expect(typeof value).not.toBe('symbol');
      }
      // And it must survive the JSON round-trip the route puts it through.
      expect(() => JSON.stringify(metric)).not.toThrow();
    }
  });

  it('exports METRIC_NOT_APPLICABLE as a Symbol, not an in-band value', async () => {
    // If it were null/0/-1, a broken getter returning that value would silently claim the
    // not-applicable state instead of being classified as a failed read.
    expect(typeof METRIC_NOT_APPLICABLE).toBe('symbol');
  });
});

describe('sharing the signal context with the skills registry (#2676)', () => {
  it('reads a shared signal ONCE across both registries', async () => {
    // The acceptance criterion: metrics must not add reads. universeCount feeds Wordsmith AND
    // recordsCreated; with one context between them it is read exactly once.
    stats.universes = 3;
    for (const stub of [countUniverses, countMemories, getLoggingStats]) vi.mocked(stub).mockClear();

    const read = createSignalContext();
    await Promise.all([getCharacterSkills(read), getCharacterMetrics(read)]);

    expect(countUniverses).toHaveBeenCalledTimes(1);
    expect(countMemories).toHaveBeenCalledTimes(1);
    expect(getLoggingStats).toHaveBeenCalledTimes(1);
  });

  it('reads a shared signal twice when the registries are given separate contexts', async () => {
    // Pins the negative: this is the waste the shared context exists to remove, so a future
    // refactor that drops the shared context has a failing test pointing at why.
    vi.mocked(countUniverses).mockClear();

    await Promise.all([getCharacterSkills(createSignalContext()), getCharacterMetrics(createSignalContext())]);

    expect(countUniverses).toHaveBeenCalledTimes(2);
  });

  it('still works standalone, minting its own context when none is passed', async () => {
    stats.memories = 8;
    expect(byId(await getCharacterMetrics(), 'memoryCount').value).toBe(8);
  });
});
