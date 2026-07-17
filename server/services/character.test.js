import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory backing for the character.json read/write so the test exercises the
// real read-modify-save path without touching disk. `birthDate` drives the mocked
// meatspace accessor so age-based level derivation is deterministic.
const store = vi.hoisted(() => ({ value: null, birthDate: null }));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/tmp/portos-test-data' },
  ensureDir: vi.fn(async () => {}),
  readJSONFile: vi.fn(async (_file, fallback) => (store.value ?? fallback)),
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

// character.js eagerly imports the jira/cos/meatspace services at module load; stub them
// so the unit under test loads without their dependency graphs. meatspace supplies the
// canonical birthDate that age-based level derives from (#2673).
vi.mock('./jira.js', () => ({}));
vi.mock('./cos.js', () => ({}));
vi.mock('./meatspace.js', () => ({
  getBirthDate: vi.fn(async () => ({ birthDate: store.birthDate })),
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn(async (_path, contents) => {
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

describe('getWireCharacter federation projection', () => {
  beforeEach(() => {
    store.value = { name: 'Gandalf', class: 'Wizard', xp: 5000, hp: 15, maxHp: 15 };
    store.birthDate = null;
  });

  it('adds an age-derived level to the wire payload without persisting it', async () => {
    const birth = new Date();
    birth.setFullYear(birth.getFullYear() - 33);
    birth.setDate(birth.getDate() - 30);
    store.birthDate = birth.toISOString();

    const wire = await characterService.getWireCharacter();
    expect(wire.level).toBe(33);
    // But the persisted record still carries no level.
    expect(store.value.level).toBeUndefined();
  });

  it('falls back to the historical default level 1 for backward-compat when birthDate is unset', async () => {
    store.birthDate = null;
    const wire = await characterService.getWireCharacter();
    expect(wire.level).toBe(1); // pre-#2673 peers index XP thresholds by level — never null
    expect(wire.ageYears).toBeUndefined(); // ageYears excluded so the sync checksum stays stable
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
