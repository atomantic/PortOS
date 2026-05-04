import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tempRoot;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'PATHS') return { ...actual.PATHS, data: tempRoot };
      return target[prop];
    },
  });
});

const local = await import('./local.js');
const characters = await import('./characters.js');
const { createWork } = local;
const {
  listCharacters, createCharacter, updateCharacter, deleteCharacter,
  mergeExtractedCharacters,
} = characters;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wr-chars-test-'));
});

afterEach(() => {
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

async function newWork() {
  const w = await createWork({ title: 'Test Work', kind: 'short-story' });
  return w.id;
}

describe('writers room — characters CRUD', () => {
  it('starts with an empty bible', async () => {
    const id = await newWork();
    expect(await listCharacters(id)).toEqual([]);
  });

  it('rejects path-traversal-shaped work ids on every read/write helper', async () => {
    // Every public helper interpolates workId into an on-disk path; a
    // crafted id like '../../etc' must be refused with a 400 before any
    // filesystem access. This protects callers that bypass the route layer.
    await expect(listCharacters('../../etc')).rejects.toThrow(/work id/i);
    await expect(createCharacter('../../etc', { name: 'X' })).rejects.toThrow(/work id/i);
    await expect(mergeExtractedCharacters('../../etc', [{ name: 'X' }])).rejects.toThrow(/work id/i);
  });

  it('rejects creating without a name', async () => {
    const id = await newWork();
    await expect(createCharacter(id, { name: '   ' })).rejects.toThrow(/name required/i);
  });

  it('rejects duplicate names (case-insensitive)', async () => {
    const id = await newWork();
    await createCharacter(id, { name: 'Aria', physicalDescription: 'short' });
    await expect(createCharacter(id, { name: 'aria' })).rejects.toThrow(/already exists/i);
  });

  it('creates and updates a profile', async () => {
    const id = await newWork();
    const c = await createCharacter(id, { name: 'Mila', physicalDescription: 'tall' });
    expect(c.name).toBe('Mila');
    expect(c.physicalDescription).toBe('tall');
    expect(c.id).toMatch(/^wr-char-/);

    const updated = await updateCharacter(id, c.id, { physicalDescription: 'tall, copper hair' });
    expect(updated.physicalDescription).toBe('tall, copper hair');
    expect(updated.source).toBe('user');
  });

  it('deletes a profile', async () => {
    const id = await newWork();
    const c = await createCharacter(id, { name: 'Vox' });
    await deleteCharacter(id, c.id);
    expect(await listCharacters(id)).toHaveLength(0);
  });
});

describe('writers room — characters merge', () => {
  it('adds new characters from extraction', async () => {
    const id = await newWork();
    const merged = await mergeExtractedCharacters(id, [
      { name: 'Aria', physicalDescription: 'thirties, athletic, auburn hair', role: 'protagonist' },
      { name: 'Mr. Voss', role: 'antagonist' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((c) => c.name === 'Aria')?.physicalDescription).toBe('thirties, athletic, auburn hair');
    expect(merged.every((c) => c.source === 'ai')).toBe(true);
  });

  it('preserves user edits when re-merging', async () => {
    const id = await newWork();
    const c = await createCharacter(id, {
      name: 'Aria',
      physicalDescription: 'USER VERSION — short, dark hair, scar on cheek',
    });
    expect(c.source).toBe('user');

    const merged = await mergeExtractedCharacters(id, [{
      name: 'aria',
      physicalDescription: 'AI VERSION — tall, blonde',
      personality: 'quiet, observant',
      role: 'protagonist',
    }]);
    const refreshed = merged.find((x) => x.id === c.id);
    expect(refreshed.physicalDescription).toBe('USER VERSION — short, dark hair, scar on cheek');
    expect(refreshed.personality).toBe('quiet, observant');
    expect(refreshed.role).toBe('protagonist');
  });

  it('matches existing character by alias when merging', async () => {
    const id = await newWork();
    await createCharacter(id, { name: 'Mr. Voss', aliases: ['Voss', 'The Director'], role: 'antagonist' });
    const merged = await mergeExtractedCharacters(id, [{
      name: 'The Director',
      physicalDescription: 'late fifties, gray suit, bald, sharp jaw',
    }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('Mr. Voss');
    expect(merged[0].physicalDescription).toBe('late fifties, gray suit, bald, sharp jaw');
  });

  it('does not duplicate when later batch entries use a new character\'s alias as their name', async () => {
    // Simulates an extraction batch where the model first introduces a
    // character with aliases, then references the same character by an
    // alias as the `name` of a later entry. Both must resolve to one
    // canonical profile — no duplicate.
    const id = await newWork();
    const merged = await mergeExtractedCharacters(id, [
      { name: 'Mr. Voss', aliases: ['Voss', 'The Director'], role: 'antagonist' },
      { name: 'The Director', physicalDescription: 'late fifties, gray suit' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('Mr. Voss');
    expect(merged[0].physicalDescription).toBe('late fifties, gray suit');
  });

  it('does not duplicate when an existing character has aliases filled in mid-batch', async () => {
    // An existing character with no aliases gets aliases filled by the
    // first incoming entry; a later entry in the same batch references the
    // character via one of those aliases. Must resolve to the same record.
    const id = await newWork();
    await createCharacter(id, { name: 'Aria' });
    const merged = await mergeExtractedCharacters(id, [
      { name: 'aria', aliases: ['Ari', 'A.'] },
      { name: 'Ari', physicalDescription: 'thirties, athletic' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].physicalDescription).toBe('thirties, athletic');
  });

  it('refreshes prose-derived metadata even when text fields are preserved', async () => {
    const id = await newWork();
    const c = await createCharacter(id, { name: 'Aria', physicalDescription: 'kept' });
    const merged = await mergeExtractedCharacters(id, [{
      name: 'Aria',
      physicalDescription: 'ignored',
      missingFromProse: ['hair color', 'eye color'],
      evidence: ['"She walked in,"'],
      firstAppearance: 'Chapter 1',
    }]);
    const updated = merged.find((x) => x.id === c.id);
    expect(updated.physicalDescription).toBe('kept');
    expect(updated.missingFromProse).toEqual(['hair color', 'eye color']);
    expect(updated.firstAppearance).toBe('Chapter 1');
  });
});
