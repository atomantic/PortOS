import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Each domain's stat getter is stubbed so the registry can be driven to its three
// interesting states — populated, empty, and read-failure — without any of the real
// dependency graphs (Postgres, the universe store, the meatspace files) loading.
const stats = vi.hoisted(() => ({
  universes: [],
  catalog: { total: 0, scraps: 0 },
  sessions: [],
  training: [],
  logging: { totalLogged: 0 },
  goals: { goals: [] },
  memories: 0,
  assets: 0,
}));

// A domain "fails" by having its stub reject — the same way a real getter surfaces an
// unreachable Postgres or an unreadable data file.
const fail = (name) => () => Promise.reject(new Error(`${name} unavailable`));

vi.mock('./universeBuilder.js', () => ({ listUniverses: vi.fn(async () => stats.universes) }));
vi.mock('./catalogDB.js', () => ({ getCatalogStats: vi.fn(async () => stats.catalog) }));
vi.mock('./meatspacePost.js', () => ({ getPostSessions: vi.fn(async () => stats.sessions) }));
vi.mock('./meatspacePostTraining.js', () => ({ getAllTrainingEntries: vi.fn(async () => stats.training) }));
vi.mock('./meatspaceLoggingStats.js', () => ({ getLoggingStats: vi.fn(async () => stats.logging) }));
vi.mock('./identity/goals.js', () => ({ getGoals: vi.fn(async () => stats.goals) }));
vi.mock('./memoryBackend.js', () => ({ countMemories: vi.fn(async () => stats.memories) }));
vi.mock('./mediaAssetIndex/db.js', () => ({ countAssets: vi.fn(async () => stats.assets) }));

import { getCharacterSkills, levelFromValue, SKILLS, MAX_SKILL_LEVEL } from './characterSkills.js';
import { listUniverses } from './universeBuilder.js';
import { getCatalogStats } from './catalogDB.js';
import { getLoggingStats } from './meatspaceLoggingStats.js';
import { countMemories } from './memoryBackend.js';
import { countAssets } from './mediaAssetIndex/db.js';

const rows = (list) => Array.from({ length: list }, (_, i) => ({ id: `r${i}` }));

// Restore every stat to the "brand new install" baseline between tests so a test that
// populates one domain can't leak into the next one's empty-domain assertions.
beforeEach(() => {
  stats.universes = [];
  stats.catalog = { total: 0, scraps: 0 };
  stats.sessions = [];
  stats.training = [];
  stats.logging = { totalLogged: 0 };
  stats.goals = { goals: [] };
  stats.memories = 0;
  stats.assets = 0;
  vi.mocked(listUniverses).mockImplementation(async () => stats.universes);
  vi.mocked(getCatalogStats).mockImplementation(async () => stats.catalog);
  vi.mocked(getLoggingStats).mockImplementation(async () => stats.logging);
  vi.mocked(countMemories).mockImplementation(async () => stats.memories);
  vi.mocked(countAssets).mockImplementation(async () => stats.assets);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const byId = (skills, id) => skills.find((s) => s.id === id);

describe('levelFromValue (the compute curve)', () => {
  it('gives an empty domain level 0 rather than dividing by zero', () => {
    expect(levelFromValue(0, 5)).toBe(0);
  });

  it('adds one level per doubling of value: (2^n - 1) x scale -> n', () => {
    // scale=1 → the curve's raw shape: 1→1, 3→2, 7→3, 15→4, 31→5.
    expect(levelFromValue(1, 1)).toBe(1);
    expect(levelFromValue(3, 1)).toBe(2);
    expect(levelFromValue(7, 1)).toBe(3);
    expect(levelFromValue(15, 1)).toBe(4);
    expect(levelFromValue(31, 1)).toBe(5);
  });

  it('climbs monotonically — more use never lowers a level', () => {
    let prev = -1;
    for (let value = 0; value <= 500; value++) {
      const level = levelFromValue(value, 3);
      expect(level).toBeGreaterThanOrEqual(prev);
      prev = level;
    }
  });

  it('stretches the curve by scale, so each domain levels at its own cadence', () => {
    // The same raw count means less in a high-cadence domain (health logs, memories).
    expect(levelFromValue(10, 1)).toBeGreaterThan(levelFromValue(10, 10));
    // One full unit of `scale` is exactly level 1 in every domain.
    expect(levelFromValue(5, 5)).toBe(1);
    expect(levelFromValue(10, 10)).toBe(1);
  });

  it('is one level short of the next bucket at the boundary', () => {
    // Just under 3x scale is still level 1; 3x scale tips to 2.
    expect(levelFromValue(2.99 * 4, 4)).toBe(1);
    expect(levelFromValue(3 * 4, 4)).toBe(2);
  });

  it('plateaus at MAX_SKILL_LEVEL instead of growing without bound', () => {
    expect(levelFromValue(Number.MAX_SAFE_INTEGER, 1)).toBe(MAX_SKILL_LEVEL);
  });

  it('floors non-finite and negative input to 0', () => {
    for (const bad of [NaN, Infinity, -Infinity, undefined, null, -5]) {
      expect(levelFromValue(bad, 3)).toBe(0);
    }
  });

  it('falls back to scale 1 when a skill declares a nonsense scale', () => {
    for (const bad of [0, -1, NaN, undefined]) {
      expect(levelFromValue(1, bad)).toBe(1);
    }
  });
});

describe('the registry', () => {
  it('declares a unique id, label, domain, positive scale and compute for each skill', () => {
    const ids = new Set();
    for (const skill of SKILLS) {
      expect(skill.id).toMatch(/^[a-z]+$/);
      expect(ids.has(skill.id)).toBe(false);
      ids.add(skill.id);
      expect(skill.label).toBeTruthy();
      expect(skill.domain).toBeTruthy();
      expect(skill.scale).toBeGreaterThan(0);
      expect(typeof skill.compute).toBe('function');
    }
  });

  it('covers the four domains the acceptance criteria require, plus Brain and Media', () => {
    expect(SKILLS.map((s) => s.domain).sort()).toEqual(
      ['brain', 'create', 'goals', 'health', 'media', 'post']
    );
  });
});

describe('getCharacterSkills — empty domains', () => {
  it('yields a real, earned level 0 for every domain on a fresh install', async () => {
    const skills = await getCharacterSkills();

    expect(skills).toHaveLength(SKILLS.length);
    for (const skill of skills) {
      // The whole point of the sentinel: an untouched domain is 0/0 and NOT unavailable.
      expect(skill).toMatchObject({ level: 0, value: 0, unavailable: false });
      expect(skill.level).not.toBeNull();
    }
  });
});

describe('getCharacterSkills — populated domains', () => {
  it('derives Wordsmith from universes + catalog ingredients + scraps', async () => {
    stats.universes = rows(3);
    stats.catalog = { total: 8, scraps: 4 }; // 3 + 8 + 4 = 15, scale 2 → 15/2+1 = 8.5 → 3
    const wordsmith = byId(await getCharacterSkills(), 'wordsmith');
    expect(wordsmith.value).toBe(15);
    expect(wordsmith.level).toBe(3);
    expect(wordsmith.unavailable).toBe(false);
  });

  it('derives Mentalist from scored sessions AND training entries together', async () => {
    stats.sessions = rows(5);
    stats.training = rows(4);
    const mentalist = byId(await getCharacterSkills(), 'mentalist');
    expect(mentalist.value).toBe(9); // union, matching the unified POST streak's semantics
    expect(mentalist.level).toBe(levelFromValue(9, 3));
  });

  it('derives Vitalist from the cumulative health log total', async () => {
    stats.logging = { totalLogged: 35 };
    const vitalist = byId(await getCharacterSkills(), 'vitalist');
    expect(vitalist.value).toBe(35);
    expect(vitalist.level).toBe(3); // 35/5 + 1 = 8 → log2 = 3
  });

  it('derives Strategist from goal discipline (check-ins + progress), not goal count', async () => {
    stats.goals = {
      goals: [
        { checkIns: rows(4), progressHistory: rows(2) },
        { checkIns: rows(1), progressHistory: rows(0) },
        {}, // a goal filed and never revisited contributes nothing
      ],
    };
    const strategist = byId(await getCharacterSkills(), 'strategist');
    expect(strategist.value).toBe(7);
    expect(strategist.level).toBe(levelFromValue(7, 3));
  });

  it('derives Archivist from the memory count', async () => {
    stats.memories = 70;
    const archivist = byId(await getCharacterSkills(), 'archivist');
    expect(archivist.value).toBe(70);
    expect(archivist.level).toBe(3); // 70/10 + 1 = 8 → log2 = 3
  });

  it('derives Auteur from the media asset index', async () => {
    stats.assets = 20;
    const auteur = byId(await getCharacterSkills(), 'auteur');
    expect(auteur.value).toBe(20);
    expect(auteur.level).toBe(levelFromValue(20, 5));
  });

  it('counts media assets without materializing every row', async () => {
    // countAssets() is a COUNT(*); listAssets() selects and JSON-parses the full payload of
    // every rendered image and video. GET /api/character is polled every 15s by the CyberCity
    // HUD, so this must never regress back to `(await listAssets()).length`.
    vi.mocked(countAssets).mockClear();
    await getCharacterSkills();
    expect(countAssets).toHaveBeenCalledTimes(1);
  });

  it('leaves untouched domains at 0 while one domain climbs', async () => {
    stats.memories = 100;
    const skills = await getCharacterSkills();
    expect(byId(skills, 'archivist').level).toBeGreaterThan(0);
    for (const skill of skills.filter((s) => s.id !== 'archivist')) {
      expect(skill).toMatchObject({ level: 0, value: 0, unavailable: false });
    }
  });
});

// NOTE ON WHAT THIS SUITE PROVES: these tests drive failure by making a stubbed getter
// reject, which exercises readSkill's classification — the registry's own job. It does NOT
// prove the real wiring can reach `unavailable`: `mentalist`, `vitalist`, and `strategist`
// bottom out in readJSONFile, which swallows read errors and returns an empty default, so
// those three can't currently reject at all. That gap is real, documented in the module
// header, and tracked in #2726 (which owns the strict-read variants and the end-to-end
// coverage). Do not read a green run here as "every domain reports failures correctly".
describe('getCharacterSkills — stat-read failure (must NOT collapse into a fake 0)', () => {
  it('marks a skill unavailable with null level/value when its stat read rejects', async () => {
    vi.mocked(countMemories).mockImplementation(fail('memory backend'));

    const archivist = byId(await getCharacterSkills(), 'archivist');
    expect(archivist.unavailable).toBe(true);
    // Null, not 0 — a 0 would read as "you have never saved a memory", which is a lie.
    expect(archivist.level).toBeNull();
    expect(archivist.value).toBeNull();
    expect(archivist.level).not.toBe(0);
  });

  it('contains a failure to its own skill — other domains still report', async () => {
    stats.logging = { totalLogged: 35 };
    vi.mocked(countMemories).mockImplementation(fail('memory backend'));

    const skills = await getCharacterSkills();
    expect(byId(skills, 'archivist').unavailable).toBe(true);
    expect(byId(skills, 'vitalist')).toMatchObject({ level: 3, value: 35, unavailable: false });
    expect(skills).toHaveLength(SKILLS.length);
  });

  it('never rejects, even when every domain is unreadable', async () => {
    vi.mocked(listUniverses).mockImplementation(fail('universe store'));
    vi.mocked(getCatalogStats).mockImplementation(fail('catalog'));
    vi.mocked(getLoggingStats).mockImplementation(fail('logging stats'));
    vi.mocked(countMemories).mockImplementation(fail('memory backend'));

    const skills = await getCharacterSkills();
    for (const id of ['wordsmith', 'vitalist', 'archivist']) {
      expect(byId(skills, id)).toMatchObject({ level: null, value: null, unavailable: true });
    }
  });

  it('marks a partially-failed multi-read skill unavailable rather than under-counting', async () => {
    // Wordsmith reads two stores. If only the catalog is down, reporting just the
    // universe count would silently understate the skill — "can't tell" is the honest answer.
    stats.universes = rows(3);
    vi.mocked(getCatalogStats).mockImplementation(fail('catalog'));

    expect(byId(await getCharacterSkills(), 'wordsmith')).toMatchObject({
      level: null, value: null, unavailable: true,
    });
  });

  it('treats a non-finite stat value as unavailable, not as 0', async () => {
    // A getter that resolves to undefined/NaN is a broken read, not an empty domain.
    for (const broken of [undefined, null, NaN, Infinity, 'twelve']) {
      vi.mocked(countMemories).mockImplementation(async () => broken);
      expect(byId(await getCharacterSkills(), 'archivist')).toMatchObject({
        level: null, value: null, unavailable: true,
      });
    }
  });

  it('treats a negative stat value as unavailable, not as level 0', async () => {
    vi.mocked(countMemories).mockImplementation(async () => -3);
    expect(byId(await getCharacterSkills(), 'archivist')).toMatchObject({
      level: null, value: null, unavailable: true,
    });
  });

  it('keeps id/label/domain on an unavailable skill so the UI can still name it', async () => {
    vi.mocked(countMemories).mockImplementation(fail('memory backend'));
    expect(byId(await getCharacterSkills(), 'archivist')).toMatchObject({
      id: 'archivist', label: 'Archivist', domain: 'brain',
    });
  });
});
