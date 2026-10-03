import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// In-memory backing for the character.json read/write so the test exercises the
// real read-modify-save path without touching disk. `birthDate` drives the mocked
// meatspace accessor so age-based level derivation is deterministic.
// `beforeWrite`, when set, is awaited just before a write lands so a test can park one writer
// mid-persist and drive an interleaving deterministically (#9817). `jira` / `tasks` feed the
// import-service stubs below.
const store = vi.hoisted(() => ({
  value: null, birthDate: null, readable: true, beforeWrite: null,
  jira: { instances: {}, projects: [], tickets: [], beforeTickets: null },
  tasks: { user: { tasks: [] }, cos: { tasks: [] }, before: null },
}));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/tmp/portos-test-data' },
  ensureDir: vi.fn(async () => {}),
  // Independent snapshots, like the real JSON read — a shared object reference would hide the
  // lost-update race by letting concurrent writers mutate the same record.
  readJSONFile: vi.fn(async (_file, fallback) => (store.value ? JSON.parse(JSON.stringify(store.value)) : fallback)),
  writeFile: vi.fn(),
  // atomicWrite replaced the raw writeFile(JSON.stringify) site (#1837); route
  // it through the mocked fs/promises.writeFile so the in-memory store update
  // (and read-modify-save round-trip) keeps working unchanged.
  atomicWrite: vi.fn(async (filePath, data) => {
    const payload = (typeof data === 'string' || Buffer.isBuffer(data)) ? data : JSON.stringify(data, null, 2);
    const { writeFile } = await import('fs/promises');
    return writeFile(filePath, payload);
  }),
}));

// character.js eagerly imports the jira/cos/meatspace/characterSkills/characterMetrics/
// characterSignals services at module load; stub them so the unit under test loads without
// their dependency graphs. meatspace supplies the canonical birthDate that age-based level
// derives from (#2673). The skill registry (#2674) and metrics grid (#2676) each fan out to
// every domain's stats and have their own suites (characterSkills.test.js /
// characterMetrics.test.js) — here we only care THAT their output is attached on read and
// stripped on save, so single sentinel entries stand in for the real registries.
const FAKE_SKILLS = [{ id: 'wordsmith', label: 'Wordsmith', domain: 'create', level: 2, value: 7, unavailable: false }];
const FAKE_METRICS = [{ id: 'recordsCreated', label: 'Records Created', unit: 'count', hint: 'x', value: 7, unavailable: false, notApplicable: false }];
// A recognizable stand-in for the shared signal context, so the tests can assert BOTH
// registries were handed the SAME one (the whole point of #2676's read-once contract).
const FAKE_READ = vi.hoisted(() => vi.fn());
vi.mock('./jira.js', () => ({
  getInstances: vi.fn(async () => ({ instances: store.jira.instances })),
  getProjects: vi.fn(async () => store.jira.projects),
  getMyCurrentSprintTickets: vi.fn(async () => {
    await store.jira.beforeTickets?.();
    return store.jira.tickets;
  }),
}));
// character.js reaches cosTaskStore for the one symbol it uses (getAllTasks); syncTaskXP
// is not exercised here, so the stub only has to satisfy the static import.
vi.mock('./cosTaskStore.js', () => ({
  getAllTasks: async () => {
    await store.tasks.before?.();
    return { user: store.tasks.user, cos: store.tasks.cos };
  },
}));
vi.mock('./characterSkills.js', () => ({
  getCharacterSkills: vi.fn(async () => FAKE_SKILLS),
}));
vi.mock('./characterMetrics.js', () => ({
  getCharacterMetrics: vi.fn(async () => FAKE_METRICS),
}));
vi.mock('./characterSignals.js', () => ({
  createSignalContext: vi.fn(() => FAKE_READ),
}));
vi.mock('./meatspace.js', () => ({
  getBirthDate: vi.fn(async () => ({ birthDate: store.birthDate })),
  // getBirthDateStrict adds the read-trustworthiness flag the birthDateStatus derivation
  // needs (#2757). `store.readable` defaults true so existing tests are unaffected; the
  // unreadable-config case flips it to false.
  getBirthDateStrict: vi.fn(async () => ({ birthDate: store.birthDate, readable: store.readable ?? true })),
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn(async (_path, contents) => {
    await store.beforeWrite?.();
    store.value = JSON.parse(contents);
  }),
}));

import * as characterService from './character.js';

describe('ageYearsFromBirthDate', () => {
  it('returns fractional years lived for a valid birthDate', () => {
    const now = new Date('2026-07-01T00:00:00Z');
    const age = characterService.ageYearsFromBirthDate('1984-01-01T00:00:00Z', now);
    expect(age).toBeGreaterThan(42);
    expect(age).toBeLessThan(43);
  });

  it('returns null for unset / invalid / future birthDate', () => {
    const now = new Date('2026-07-01T00:00:00Z');
    expect(characterService.ageYearsFromBirthDate(null, now)).toBeNull();
    expect(characterService.ageYearsFromBirthDate('', now)).toBeNull();
    expect(characterService.ageYearsFromBirthDate('not-a-date', now)).toBeNull();
    expect(characterService.ageYearsFromBirthDate('2030-01-01', now)).toBeNull();
  });

  it('uses calendar birthdays — does not tick the level up a day early', () => {
    // The day BEFORE the 26th birthday: still 25 (a 365.25-day average would round to 26).
    const dayBefore = characterService.ageYearsFromBirthDate('2000-07-17', new Date('2026-07-16T00:00:00Z'));
    expect(Math.floor(dayBefore)).toBe(25);
    // On the birthday: ticks to 26 with ~0 progress.
    const onBirthday = characterService.ageYearsFromBirthDate('2000-07-17', new Date('2026-07-17T00:00:00Z'));
    expect(Math.floor(onBirthday)).toBe(26);
    expect(onBirthday - 26).toBeLessThan(0.01);
  });
});

describe('levelFromAge', () => {
  it('floors age years to a level', () => {
    expect(characterService.levelFromAge(42.9)).toBe(42);
    expect(characterService.levelFromAge(0.4)).toBe(0);
  });
  it('returns null when age is null / NaN', () => {
    expect(characterService.levelFromAge(null)).toBeNull();
    expect(characterService.levelFromAge(NaN)).toBeNull();
  });
});

describe('birthDateStatusFrom (#2757)', () => {
  const now = new Date('2026-07-01T00:00:00Z');
  it('reports unreadable when the config read is untrustworthy, even with a would-be-valid date', () => {
    expect(characterService.birthDateStatusFrom('1984-01-01', false, now)).toBe('unreadable');
    expect(characterService.birthDateStatusFrom(null, false, now)).toBe('unreadable');
  });
  it('reports unset for an absent date on a readable config', () => {
    expect(characterService.birthDateStatusFrom(null, true, now)).toBe('unset');
    expect(characterService.birthDateStatusFrom('', true, now)).toBe('unset');
  });
  it('reports invalid for an unparseable date', () => {
    expect(characterService.birthDateStatusFrom('not-a-date', true, now)).toBe('invalid');
  });
  it('reports invalid for an impossible/normalized calendar day (not a bogus level) (#2757 codex)', () => {
    // new Date('2021-02-29') silently rolls to Mar 1 — must be rejected, not treated as ok.
    expect(characterService.birthDateStatusFrom('2021-02-29', true, now)).toBe('invalid');
    expect(characterService.birthDateStatusFrom('2024-02-30', true, now)).toBe('invalid');
    expect(characterService.birthDateStatusFrom('0', true, now)).toBe('invalid');
    expect(characterService.birthDateStatusFrom('1990/05/15', true, now)).toBe('invalid');
  });
  it('reports invalid when a valid date prefix has unparseable trailing garbage', () => {
    // The prefix regex alone passes this, but `new Date()` rejects the full
    // string — status must not say 'ok' while the level derives null.
    expect(characterService.birthDateStatusFrom('1990-05-10garbage', true, now)).toBe('invalid');
  });
  it('accepts a full ISO timestamp (legacy/migrated storage), not just YYYY-MM-DD', () => {
    expect(characterService.birthDateStatusFrom('1984-01-01T00:00:00.000Z', true, now)).toBe('ok');
  });
  it('reports future for a date past now', () => {
    expect(characterService.birthDateStatusFrom('2030-01-01', true, now)).toBe('future');
  });
  it('reports ok for a usable past date', () => {
    expect(characterService.birthDateStatusFrom('1984-01-01', true, now)).toBe('ok');
  });
});

describe('getCharacter birthDateStatus (#2757)', () => {
  beforeEach(() => {
    store.value = { name: 'Gandalf', class: 'Wizard', xp: 0, hp: 15, maxHp: 15, events: [] };
    store.birthDate = null;
    store.readable = true;
  });
  afterEach(() => { store.readable = true; });

  it('is "unset" with a null level when no birthDate is on record', async () => {
    const char = await characterService.getCharacter();
    expect(char.level).toBeNull();
    expect(char.birthDateStatus).toBe('unset');
  });

  it('is "invalid" for a present-but-unparseable birthDate (still null level)', async () => {
    store.birthDate = 'not-a-date';
    const char = await characterService.getCharacter();
    expect(char.level).toBeNull();
    expect(char.birthDateStatus).toBe('invalid');
  });

  it('is "unreadable" when the meatspace config read fails, distinct from unset', async () => {
    store.readable = false;
    const char = await characterService.getCharacter();
    expect(char.level).toBeNull();
    expect(char.birthDateStatus).toBe('unreadable');
  });

  it('is "ok" for a usable past birthDate', async () => {
    const birth = new Date();
    birth.setFullYear(birth.getFullYear() - 40);
    birth.setDate(birth.getDate() - 30);
    store.birthDate = birth.toISOString();
    const char = await characterService.getCharacter();
    expect(char.level).toBe(40);
    expect(char.birthDateStatus).toBe('ok');
  });

  it('never persists birthDateStatus to character.json', async () => {
    const char = await characterService.getCharacter();
    await characterService.saveCharacter(char);
    expect(store.value.birthDateStatus).toBeUndefined();
  });

  it('is stripped from the federation wire payload', async () => {
    store.value = { ...store.value, birthDateStatus: 'ok' };
    const wire = await characterService.getWireCharacter();
    expect(wire.birthDateStatus).toBeUndefined();
  });
});

describe('getCharacter age-based level', () => {
  beforeEach(() => {
    store.value = { name: 'Gandalf', class: 'Wizard', xp: 5000, level: 3, hp: 15, maxHp: 15 };
    store.birthDate = null;
  });

  it('derives level = floor(ageYears) from the canonical birthDate, ignoring stored xp/level', async () => {
    // ~42 years before today → level 42, regardless of the persisted level: 3 / xp: 5000.
    const birth = new Date();
    birth.setFullYear(birth.getFullYear() - 42);
    birth.setDate(birth.getDate() - 30); // safely past the birthday so age is >= 42
    store.birthDate = birth.toISOString();

    const char = await characterService.getCharacter();
    expect(char.level).toBe(42);
    expect(char.ageYears).toBeGreaterThanOrEqual(42);
    expect(char.xp).toBe(5000); // xp survives as a stat
  });

  it('returns level = null when no birthDate is set', async () => {
    store.birthDate = null;
    const char = await characterService.getCharacter();
    expect(char.level).toBeNull();
    expect(char.ageYears).toBeNull();
  });

  it('loads a legacy character.json (stored xp/level) without error', async () => {
    store.value = { name: 'Legacy', class: 'Dev', xp: 12345, level: 7, hp: 20, maxHp: 20 };
    store.birthDate = null;
    const char = await characterService.getCharacter();
    expect(char.name).toBe('Legacy');
    expect(char.level).toBeNull(); // no longer XP-derived
    expect(char.xp).toBe(12345);
  });
});

describe('stripDerivedFields', () => {
  it('removes every derived field and leaves persisted ones untouched', () => {
    const stripped = characterService.stripDerivedFields({
      name: 'Gandalf', xp: 5000, hp: 15, events: [],
      level: 99, ageYears: 999, skills: [{ id: 'stale' }], metrics: [{ id: 'stale' }],
    });
    expect(stripped).toEqual({ name: 'Gandalf', xp: 5000, hp: 15, events: [] });
  });

  it('copies rather than mutating its input', () => {
    // saveCharacter/getWireCharacter/dataSync all pass records their callers still hold.
    const original = { name: 'Gandalf', level: 99, skills: [] };
    const stripped = characterService.stripDerivedFields(original);
    expect(original.level).toBe(99);
    expect(stripped.level).toBeUndefined();
  });

  it('is a no-op on a record that carries no derived fields', () => {
    expect(characterService.stripDerivedFields({ name: 'Gandalf' })).toEqual({ name: 'Gandalf' });
  });
});

describe('getWireCharacter federation projection', () => {
  beforeEach(() => {
    store.value = { name: 'Gandalf', class: 'Wizard', xp: 5000, hp: 15, maxHp: 15 };
    store.birthDate = null;
  });

  it('adds a legacy xp-derived level to the wire payload without persisting it', async () => {
    // 5000 xp → legacy level 4 (>= the 2700 threshold, < 6500). A valid integer for a
    // pre-#2673 peer's XP-threshold UI, never null.
    const wire = await characterService.getWireCharacter();
    expect(wire.level).toBe(4);
    expect(store.value.level).toBeUndefined(); // still not persisted
    expect(wire.ageYears).toBeUndefined();
  });

  it('keeps the wire level a pure function of xp (checksum-stable), independent of birthDate', async () => {
    // Setting a birthDate must NOT change the wire level — otherwise it would drift out of
    // sync with the character.json-mtime checksum that fingerprints the sync category.
    const birth = new Date();
    birth.setFullYear(birth.getFullYear() - 33);
    store.birthDate = birth.toISOString();
    const wire = await characterService.getWireCharacter();
    expect(wire.level).toBe(4); // xp-derived, not age 33

    store.value = { name: 'New', class: 'Dev', xp: 0, hp: 15, maxHp: 15 };
    const fresh = await characterService.getWireCharacter();
    expect(fresh.level).toBe(1); // 0 xp → level 1, never null
  });

  it('never federates the usage-derived skills or metrics', async () => {
    // Both are per-machine (usage differs across a user's peers), so sending them would let
    // the least-used peer clobber the most-used one under LWW.
    const wire = await characterService.getWireCharacter();
    expect(wire.skills).toBeUndefined();
    expect(wire.metrics).toBeUndefined();
  });

  it('strips a STALE derived field already sitting in character.json', async () => {
    // The load-bearing case: saveCharacter never writes these, but a hand-edited file (or one
    // from a peer that did) can carry them. applyCharacterRemote's no-local branch writes the
    // wire payload verbatim, so anything that survives here self-propagates across peers.
    store.value = {
      ...store.value,
      skills: [{ id: 'stale', level: 99 }],
      metrics: [{ id: 'stale', value: 99 }],
      ageYears: 999,
      level: 99,
    };

    const wire = await characterService.getWireCharacter();
    expect(wire.skills).toBeUndefined();
    expect(wire.metrics).toBeUndefined();
    expect(wire.ageYears).toBeUndefined();
    expect(wire.level).toBe(4); // re-derived from xp, NOT the stale 99
  });
});

describe('getCharacter skills (derived on read, #2674)', () => {
  beforeEach(() => {
    store.value = { name: 'Gandalf', class: 'Wizard', xp: 0, hp: 15, maxHp: 15, events: [] };
    store.birthDate = null;
  });

  it('attaches the skill registry output on read', async () => {
    const character = await characterService.getCharacter();
    expect(character.skills).toEqual(FAKE_SKILLS);
  });

  it('never persists skills to character.json', async () => {
    const character = await characterService.getCharacter();
    expect(character.skills).toBeDefined();

    // Round-trip the enriched record straight back through save — the path a caller takes
    // when it reads, mutates, and writes — and the derived skills must not survive it.
    await characterService.saveCharacter(character);
    expect(store.value.skills).toBeUndefined();
    expect(store.value.level).toBeUndefined();
    expect(store.value.ageYears).toBeUndefined();
  });

  it('re-derives skills on the record that save returns', async () => {
    const saved = await characterService.saveCharacter(await characterService.getCharacter());
    expect(saved.skills).toEqual(FAKE_SKILLS);
  });

  it('keeps a stale persisted skills array from leaking through as truth', async () => {
    // An older/hand-edited character.json (or a peer that once persisted them) may carry a
    // stored skills key. The read must overwrite it with freshly-derived values.
    store.value = { ...store.value, skills: [{ id: 'stale', level: 99 }] };
    const character = await characterService.getCharacter();
    expect(character.skills).toEqual(FAKE_SKILLS);
  });

  it('skips the skill fan-out entirely when withSkills is false', async () => {
    const { getCharacterSkills } = await import('./characterSkills.js');
    vi.mocked(getCharacterSkills).mockClear();

    const character = await characterService.getCharacter({ withSkills: false });

    expect(getCharacterSkills).not.toHaveBeenCalled();
    // Absent, NOT [] — "not computed" must not read as "computed, every domain empty".
    expect('skills' in character).toBe(false);
    expect(character.level).toBeDefined(); // the cheap age level still resolves
  });

  it('drops a stale persisted skills key even when withSkills is false', async () => {
    // Otherwise skipping the fan-out would hand the caller a hand-edited file's own `skills`
    // array dressed up as derived output.
    store.value = { ...store.value, skills: [{ id: 'stale', level: 99 }] };
    const character = await characterService.getCharacter({ withSkills: false });
    expect('skills' in character).toBe(false);
  });
});

describe('getCharacter metrics (derived on read, #2676)', () => {
  beforeEach(() => {
    store.value = { name: 'Gandalf', class: 'Wizard', xp: 0, hp: 15, maxHp: 15, events: [] };
    store.birthDate = null;
  });

  it('attaches the metrics registry output on read', async () => {
    const character = await characterService.getCharacter();
    expect(character.metrics).toEqual(FAKE_METRICS);
  });

  it('never persists metrics to character.json', async () => {
    const character = await characterService.getCharacter();
    expect(character.metrics).toBeDefined();

    // Round-trip the enriched record straight back through save — the path a caller takes
    // when it reads, mutates, and writes — and the derived metrics must not survive it.
    await characterService.saveCharacter(character);
    expect(store.value.metrics).toBeUndefined();
  });

  it('re-derives metrics on the record that save returns', async () => {
    const saved = await characterService.saveCharacter(await characterService.getCharacter());
    expect(saved.metrics).toEqual(FAKE_METRICS);
  });

  it('keeps a stale persisted metrics array from leaking through as truth', async () => {
    store.value = { ...store.value, metrics: [{ id: 'stale', value: 99 }] };
    const character = await characterService.getCharacter();
    expect(character.metrics).toEqual(FAKE_METRICS);
  });

  it('skips the metrics fan-out entirely when withMetrics is false', async () => {
    const { getCharacterMetrics } = await import('./characterMetrics.js');
    vi.mocked(getCharacterMetrics).mockClear();

    const character = await characterService.getCharacter({ withMetrics: false });

    expect(getCharacterMetrics).not.toHaveBeenCalled();
    // Absent, NOT [] — "not computed" must not read as "computed, every domain empty".
    expect('metrics' in character).toBe(false);
    expect(character.level).toBeDefined(); // the cheap age level still resolves
  });

  it('drops a stale persisted metrics key even when withMetrics is false', async () => {
    store.value = { ...store.value, metrics: [{ id: 'stale', value: 99 }] };
    const character = await characterService.getCharacter({ withMetrics: false });
    expect('metrics' in character).toBe(false);
  });

  it('gates the two registries independently', async () => {
    const { getCharacterSkills } = await import('./characterSkills.js');
    const { getCharacterMetrics } = await import('./characterMetrics.js');
    vi.mocked(getCharacterSkills).mockClear();
    vi.mocked(getCharacterMetrics).mockClear();

    const character = await characterService.getCharacter({ withSkills: false, withMetrics: true });

    expect(getCharacterSkills).not.toHaveBeenCalled();
    expect(getCharacterMetrics).toHaveBeenCalled();
    expect('skills' in character).toBe(false);
    expect(character.metrics).toEqual(FAKE_METRICS);
  });
});

describe('shared signal context (read-once, #2676)', () => {
  beforeEach(() => {
    store.value = { name: 'Gandalf', class: 'Wizard', xp: 0, hp: 15, maxHp: 15, events: [] };
    store.birthDate = null;
  });

  it('hands BOTH registries the same context, so shared signals are read once', async () => {
    // The load-bearing assertion of #2676: six of the nine domain signals feed both the
    // skills and the metrics. If each registry minted its own context they would each read
    // those six, doubling the fan-out of a route the OpenWorld HUD polls every 15s.
    const { createSignalContext } = await import('./characterSignals.js');
    const { getCharacterSkills } = await import('./characterSkills.js');
    const { getCharacterMetrics } = await import('./characterMetrics.js');
    vi.mocked(createSignalContext).mockClear();

    await characterService.getCharacter();

    expect(createSignalContext).toHaveBeenCalledTimes(1);
    expect(getCharacterSkills).toHaveBeenCalledWith(FAKE_READ);
    expect(getCharacterMetrics).toHaveBeenCalledWith(FAKE_READ);
  });

  it('does not mint a context at all when both registries are skipped', async () => {
    // The cheap path (OpenWorld HUD, askService, city snapshots) must stay free of any
    // domain-signal machinery.
    const { createSignalContext } = await import('./characterSignals.js');
    vi.mocked(createSignalContext).mockClear();

    await characterService.getCharacter({ withSkills: false, withMetrics: false });

    expect(createSignalContext).not.toHaveBeenCalled();
  });
});

describe('updateCharacterFields', () => {
  beforeEach(() => {
    store.value = { name: 'Gandalf', class: 'Wizard', xp: 0, hp: 15, maxHp: 15, events: [] };
    store.birthDate = null;
  });

  it('applies only the provided fields and returns the enriched record', async () => {
    const updated = await characterService.updateCharacterFields({ name: 'Radagast' });
    expect(updated.name).toBe('Radagast');
    expect(updated.class).toBe('Wizard'); // untouched
    expect(updated.skills).toEqual(FAKE_SKILLS);
    expect(store.value.name).toBe('Radagast');
  });

  it('ignores undefined fields rather than writing them over existing values', async () => {
    await characterService.updateCharacterFields({ name: undefined, class: 'Ranger' });
    expect(store.value.name).toBe('Gandalf');
    expect(store.value.class).toBe('Ranger');
  });
});

describe('addXP decoupled from level', () => {
  beforeEach(() => {
    store.value = { name: 'Gandalf', class: 'Wizard', xp: 0, hp: 15, maxHp: 15, events: [] };
    store.birthDate = null;
  });

  it('accumulates xp but never levels up (level is age-derived)', async () => {
    const result = await characterService.addXP(100000, 'test', 'big gain');
    expect(result.leveledUp).toBe(false);
    expect(result.character.xp).toBe(100000);
    // No birthDate → derived level stays null; xp does not resurrect a level.
    expect(result.character.level).toBeNull();
  });

  it('does not persist a derived level onto disk', async () => {
    const birth = new Date();
    birth.setFullYear(birth.getFullYear() - 30);
    birth.setDate(birth.getDate() - 30);
    store.birthDate = birth.toISOString();

    await characterService.addXP(50, 'test', 'gain');
    // The enriched read carries level, but the persisted record must not.
    expect(store.value.level).toBeUndefined();
    expect(store.value.ageYears).toBeUndefined();
    expect(store.value.xp).toBe(50);
  });
});

describe('character setAvatar', () => {
  beforeEach(() => {
    store.value = { name: 'Gandalf', class: 'Wizard', avatarPath: null, xp: 0 };
    store.birthDate = null;
  });

  it('persists avatarPath onto the existing character and returns it', async () => {
    const updated = await characterService.setAvatar('/data/images/avatar.png');

    expect(updated.avatarPath).toBe('/data/images/avatar.png');
    // Other fields are preserved (read-modify-save, not a replace).
    expect(updated.name).toBe('Gandalf');
    expect(updated.class).toBe('Wizard');
    // And it was actually persisted.
    expect(store.value.avatarPath).toBe('/data/images/avatar.png');
  });
});

// #9817 — every read-modify-write enters ONE queue and re-reads inside it, so overlapping
// requests / background jobs can't each persist a stale full document over the other.
describe('Character mutation queue (#9817)', () => {
  // Park the FIRST write until `release()`; later writes pass straight through. Lets a test
  // start writer A, start writer B while A is mid-persist, then let both finish.
  function parkFirstWrite() {
    let release;
    const gate = new Promise(r => { release = r; });
    let parked = false;
    let signalParked;
    const parkedSignal = new Promise(r => { signalParked = r; });
    store.beforeWrite = async () => {
      if (parked) return;
      parked = true;
      signalParked();
      await gate;
    };
    return { release, parkedSignal };
  }

  beforeEach(() => {
    store.value = { name: 'Before', class: 'Wizard', xp: 100, hp: 15, maxHp: 15, events: [], syncedJiraTickets: [], syncedTaskIds: [], updatedAt: '2026-01-01T00:00:00.000Z' };
    store.birthDate = null;
    store.beforeWrite = null;
    store.jira = { instances: {}, projects: [], tickets: [], beforeTickets: null };
    store.tasks = { user: { tasks: [] }, cos: { tasks: [] }, before: null };
  });

  afterEach(() => { store.beforeWrite = null; });

  it('keeps a name edit AND the XP gain (one event) when the edit lands while XP is persisting', async () => {
    const { release, parkedSignal } = parkFirstWrite();
    const xp = characterService.addXP(25, 'test', 'gain');
    await parkedSignal;
    const edit = characterService.updateCharacterFields({ name: 'After' });
    // Let the queued edit start its (blocked-behind-XP) read before XP's write lands.
    await new Promise(r => setTimeout(r, 0));
    release();
    await Promise.all([xp, edit]);

    expect(store.value.name).toBe('After');
    expect(store.value.xp).toBe(125);
    expect(store.value.events.filter(e => e.type === 'xp')).toHaveLength(1);
  });

  it('keeps both when the edit starts first and XP follows', async () => {
    const { release, parkedSignal } = parkFirstWrite();
    const edit = characterService.updateCharacterFields({ name: 'After' });
    await parkedSignal;
    const xp = characterService.addXP(25, 'test', 'gain');
    await new Promise(r => setTimeout(r, 0));
    release();
    await Promise.all([edit, xp]);

    expect(store.value.name).toBe('After');
    expect(store.value.xp).toBe(125);
    expect(store.value.events.filter(e => e.type === 'xp')).toHaveLength(1);
  });

  it('preserves both of two overlapping local increments', async () => {
    const { release, parkedSignal } = parkFirstWrite();
    const a = characterService.addXP(10, 'a', 'A');
    await parkedSignal;
    const b = characterService.addXP(20, 'b', 'B');
    await new Promise(r => setTimeout(r, 0));
    release();
    await Promise.all([a, b]);

    expect(store.value.xp).toBe(130);
    expect(store.value.events).toHaveLength(2);
  });

  it('a rejected mutation neither persists nor wedges the queue', async () => {
    await expect(characterService.takeDamage('not-dice')).rejects.toThrow(/Invalid dice/);
    store.beforeWrite = async () => { throw new Error('disk full'); };
    await expect(characterService.addXP(5, 'x', 'x')).rejects.toThrow('disk full');
    store.beforeWrite = null;

    const ok = await characterService.addXP(7, 'x', 'x');
    expect(ok.character.xp).toBe(107);
    expect(store.value.xp).toBe(107);
  });

  it('reset is queued behind an in-flight mutation instead of being overwritten by it', async () => {
    const { release, parkedSignal } = parkFirstWrite();
    const xp = characterService.addXP(25, 'test', 'gain');
    await parkedSignal;
    const reset = characterService.resetCharacter();
    await new Promise(r => setTimeout(r, 0));
    release();
    await Promise.all([xp, reset]);

    expect(store.value.xp).toBe(0);
    expect(store.value.events).toEqual([]);
  });

  describe('federation apply', () => {
    const remote = (over = {}) => ({
      name: 'Remote', class: 'Wizard', xp: 100, hp: 15, maxHp: 15,
      events: [{ id: 'r1', type: 'xp', xp: 0, timestamp: '2026-02-01T00:00:00.000Z' }],
      syncedJiraTickets: [], syncedTaskIds: [], updatedAt: '2000-01-01T00:00:00.000Z', level: 9, skills: [{ id: 'stale' }],
      ...over,
    });

    it('a local edit racing a federation merge keeps union events and the newer scalar', async () => {
      const { release, parkedSignal } = parkFirstWrite();
      const edit = characterService.updateCharacterFields({ name: 'LocalEdit' });
      await parkedSignal;
      // Remote is OLDER than the local edit's fresh updatedAt, so the local name must win (LWW).
      const apply = characterService.applyRemoteSnapshot(remote());
      await new Promise(r => setTimeout(r, 0));
      release();
      await Promise.all([edit, apply]);

      expect(store.value.name).toBe('LocalEdit');
      expect(store.value.events.map(e => e.id)).toContain('r1');
      expect(store.value.level).toBeUndefined();
      expect(store.value.skills).toBeUndefined();
    });

    it('a newer remote scalar wins, and a local XP gain that raced it survives as an event', async () => {
      const { release, parkedSignal } = parkFirstWrite();
      const xp = characterService.addXP(25, 'test', 'gain');
      await parkedSignal;
      const apply = characterService.applyRemoteSnapshot(remote({ name: 'RemoteNewer', updatedAt: '2999-01-01T00:00:00.000Z' }));
      await new Promise(r => setTimeout(r, 0));
      release();
      await Promise.all([xp, apply]);

      expect(store.value.name).toBe('RemoteNewer');
      expect(store.value.xp).toBe(125);
      expect(store.value.events.filter(e => e.type === 'xp' && e.xp === 25)).toHaveLength(1);
      expect(store.value.events.map(e => e.id)).toContain('r1');
    });

    it('accepts the remote record (derived fields stripped) when nothing exists locally', async () => {
      store.value = null;
      const result = await characterService.applyRemoteSnapshot(remote());
      expect(result).toEqual({ applied: true, count: 1 });
      expect(store.value.level).toBeUndefined();
      expect(store.value.skills).toBeUndefined();
      expect(store.value.name).toBe('Remote');
    });

    it('reports not-applied when the remote adds nothing', async () => {
      const result = await characterService.applyRemoteSnapshot(remote({ events: [] }));
      expect(result).toEqual({ applied: false, count: 0 });
    });
  });

  describe('imports re-check deduplication after slow discovery', () => {
    it('syncTaskXP does not double-grant a task another writer synced during discovery', async () => {
      store.tasks.user = { tasks: [{ id: 't1', status: 'completed', title: 'One' }, { id: 't2', status: 'completed', title: 'Two' }] };
      store.tasks.before = async () => {
        // A concurrent writer (e.g. a federation merge) records t1 while discovery is in flight.
        await characterService.applyRemoteSnapshot({
          ...store.value, syncedTaskIds: ['t1'], updatedAt: '2999-01-01T00:00:00.000Z',
        });
      };
      const result = await characterService.syncTaskXP();

      expect(result.taskCount).toBe(1);
      expect(result.totalXP).toBe(25);
      expect(store.value.syncedTaskIds.sort()).toEqual(['t1', 't2']);
      expect(store.value.xp).toBe(125);
    });

    it('syncJiraXP does not double-grant a ticket synced during discovery, and keeps a racing edit', async () => {
      store.jira = {
        instances: { main: {} },
        projects: [{ key: 'PRJ' }],
        tickets: [
          { key: 'PRJ-1', summary: 'a', status: 'Done', storyPoints: 2 },
          { key: 'PRJ-2', summary: 'b', statusCategory: 'Done' },
          { key: 'PRJ-3', summary: 'c', status: 'In Progress' },
        ],
        beforeTickets: async () => {
          await characterService.updateCharacterFields({ name: 'Edited' });
          await characterService.applyRemoteSnapshot({ ...store.value, syncedJiraTickets: ['PRJ-1'], updatedAt: '2999-01-01T00:00:00.000Z' });
        },
      };
      const result = await characterService.syncJiraXP();

      expect(result.ticketCount).toBe(1);
      expect(result.totalXP).toBe(50);
      expect(store.value.name).toBe('Edited');
      expect(store.value.syncedJiraTickets.sort()).toEqual(['PRJ-1', 'PRJ-2']);
    });
  });
});
