import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './198-character-clear-legacy-rpg-defaults.js';

let rootDir;

const CHARACTER_REL = 'data/character.json';

async function seed(character) {
  await mkdir(join(rootDir, 'data'), { recursive: true });
  await writeFile(join(rootDir, CHARACTER_REL), JSON.stringify(character, null, 2));
}

async function readCharacter() {
  return JSON.parse(await readFile(join(rootDir, CHARACTER_REL), 'utf-8'));
}

const character = (overrides = {}) => ({
  name: 'Adventurer',
  class: 'Developer',
  xp: 100,
  hp: 15,
  maxHp: 15,
  events: [],
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-01T00:00:00.000Z',
  ...overrides,
});

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-mig198-'));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('198-character-clear-legacy-rpg-defaults', () => {
  it('clears the exact legacy name and class, preserving other fields', async () => {
    await seed(character());

    const result = await migration.up({ rootDir });

    expect(result.cleared).toBe(true);
    const out = await readCharacter();
    expect(out.name).toBe('');
    expect(out.class).toBe('');
    // Everything else is preserved.
    expect(out.xp).toBe(100);
    expect(out.events).toEqual([]);
    // updatedAt is refreshed since a change landed.
    expect(out.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('clears each legacy default independently', async () => {
    await seed(character({ name: 'Alice', class: 'Developer' }));
    expect((await migration.up({ rootDir })).cleared).toBe(true);
    const out = await readCharacter();
    expect(out.name).toBe('Alice'); // a deliberate name is kept
    expect(out.class).toBe('');     // the legacy class is cleared
  });

  it('leaves a personalized name/class untouched (no rewrite)', async () => {
    await seed(character({ name: 'Alice', class: 'Explorer' }));
    const before = await readFile(join(rootDir, CHARACTER_REL), 'utf-8');

    const result = await migration.up({ rootDir });

    expect(result.cleared).toBe(false);
    expect(await readFile(join(rootDir, CHARACTER_REL), 'utf-8')).toBe(before);
  });

  it('is a no-op on a fresh post-#2677 install (already-blank seed)', async () => {
    await seed(character({ name: '', class: '' }));
    const before = await readFile(join(rootDir, CHARACTER_REL), 'utf-8');

    expect((await migration.up({ rootDir })).cleared).toBe(false);
    expect(await readFile(join(rootDir, CHARACTER_REL), 'utf-8')).toBe(before);
  });

  it('tolerates a missing character.json', async () => {
    expect(await migration.up({ rootDir })).toEqual({ cleared: false, reason: 'no-file' });
  });

  it('skips an unparseable or unexpectedly-shaped file rather than destroying it', async () => {
    await mkdir(join(rootDir, 'data'), { recursive: true });
    await writeFile(join(rootDir, CHARACTER_REL), '{not json');
    expect((await migration.up({ rootDir })).reason).toBe('unparseable');
    expect(await readFile(join(rootDir, CHARACTER_REL), 'utf-8')).toBe('{not json');

    await writeFile(join(rootDir, CHARACTER_REL), '[]');
    expect((await migration.up({ rootDir })).reason).toBe('unexpected-shape');
  });
});
