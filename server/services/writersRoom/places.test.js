import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tempRoot });
});

const local = await import('./local.js');
const places = await import('./places.js');
const { createWork } = local;
const {
  listPlaces, createPlace, updatePlace, deletePlace,
  mergeExtractedPlaces, normalizeSlugline,
} = places;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wr-places-test-'));
});

afterEach(() => {
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

async function newWork() {
  const w = await createWork({ title: 'Test Work', kind: 'short-story' });
  return w.id;
}

describe('writers room — normalizeSlugline', () => {
  it('collapses em-dash, en-dash, and hyphen variants to the same key', () => {
    const a = normalizeSlugline('INT. KITCHEN — NIGHT');
    const b = normalizeSlugline('INT. KITCHEN – NIGHT');
    const c = normalizeSlugline('INT. KITCHEN - NIGHT');
    const d = normalizeSlugline('INT KITCHEN NIGHT');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(c).toBe(d);
  });

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(normalizeSlugline('int. kitchen — night')).toBe(normalizeSlugline('INT.    KITCHEN  —  NIGHT'));
  });

  it('returns empty for blank input', () => {
    expect(normalizeSlugline('')).toBe('');
    expect(normalizeSlugline(null)).toBe('');
    expect(normalizeSlugline(undefined)).toBe('');
  });
});

describe('writers room — places CRUD', () => {
  it('starts with an empty bible', async () => {
    const id = await newWork();
    expect(await listPlaces(id)).toEqual([]);
  });

  it('rejects path-traversal-shaped work ids on every read/write helper', async () => {
    await expect(listPlaces('../../etc')).rejects.toThrow(/work id/i);
    await expect(createPlace('../../etc', { slugline: 'X' })).rejects.toThrow(/work id/i);
    await expect(mergeExtractedPlaces('../../etc', [{ slugline: 'X' }])).rejects.toThrow(/work id/i);
  });

  it('rejects creating a place with neither slugline nor name', async () => {
    const id = await newWork();
    await expect(createPlace(id, {})).rejects.toThrow(/slugline or a name/i);
  });

  it('rejects duplicate sluglines after normalization', async () => {
    const id = await newWork();
    await createPlace(id, { slugline: 'INT. KITCHEN — NIGHT', description: 'cozy' });
    await expect(createPlace(id, { slugline: 'int. kitchen - night' })).rejects.toThrow(/already exists/i);
  });

  it('creates and updates a place profile', async () => {
    const id = await newWork();
    const p = await createPlace(id, { slugline: 'EXT. ROOFTOP — DAWN', description: 'pink sky' });
    expect(p.slugline).toBe('EXT. ROOFTOP — DAWN');
    expect(p.id).toMatch(/^wr-place-/);

    const updated = await updatePlace(id, p.id, { description: 'pink sky over a copper city' });
    expect(updated.description).toBe('pink sky over a copper city');
    expect(updated.source).toBe('user');
  });

  it('deletes a place', async () => {
    const id = await newWork();
    const p = await createPlace(id, { slugline: 'INT. ATTIC — DUSK' });
    await deletePlace(id, p.id);
    expect(await listPlaces(id)).toHaveLength(0);
  });

  it('rejects an update that would leave both slugline and name blank (name-only created)', async () => {
    const id = await newWork();
    const p = await createPlace(id, { name: 'The Glass Atrium' });
    await expect(updatePlace(id, p.id, { name: '' })).rejects.toThrow(/slugline or name/i);
  });

  it('rejects an update that would leave both slugline and name blank (slugline-only created)', async () => {
    const id = await newWork();
    const p = await createPlace(id, { slugline: 'INT. ATTIC — DUSK' });
    await updatePlace(id, p.id, { name: '' });
    await expect(updatePlace(id, p.id, { slugline: '' })).rejects.toThrow(/slugline or name/i);
  });
});

describe('writers room — places merge', () => {
  it('adds new places from extraction', async () => {
    const id = await newWork();
    const merged = await mergeExtractedPlaces(id, [
      { slugline: 'INT. KITCHEN — NIGHT', description: 'warm' },
      { slugline: 'EXT. ROOFTOP — DAWN', name: 'Dawn Rooftop', description: 'pink' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.every((p) => p.source === 'ai')).toBe(true);
  });

  it('preserves user edits when re-merging (fill-blanks-only)', async () => {
    const id = await newWork();
    const p = await createPlace(id, {
      slugline: 'INT. KITCHEN — NIGHT',
      description: 'USER VERSION — copper kettle on the stove',
    });
    expect(p.source).toBe('user');

    const merged = await mergeExtractedPlaces(id, [{
      slugline: 'INT. KITCHEN — NIGHT',
      description: 'AI VERSION — generic kitchen',
      palette: 'warm amber and ochre',
      era: 'modern',
    }]);
    const refreshed = merged.find((x) => x.id === p.id);
    expect(refreshed.description).toBe('USER VERSION — copper kettle on the stove');
    expect(refreshed.palette).toBe('warm amber and ochre');
    expect(refreshed.era).toBe('modern');
  });

  it('matches an existing place by name when the incoming entry uses slugline', async () => {
    const id = await newWork();
    await createPlace(id, { name: 'Eldritch Library' });
    const merged = await mergeExtractedPlaces(id, [{
      slugline: 'INT. ELDRITCH LIBRARY — NIGHT',
      name: 'Eldritch Library',
      description: 'rows of leather spines, dust motes',
    }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe('rows of leather spines, dust motes');
  });

  it('matches an existing slugline-only place by name on subsequent merges', async () => {
    const id = await newWork();
    await mergeExtractedPlaces(id, [{ slugline: 'EXT. SEAWALL — DUSK' }]);
    const merged = await mergeExtractedPlaces(id, [{
      name: 'EXT. SEAWALL — DUSK',
      description: 'salt-bleached concrete, gulls overhead',
    }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe('salt-bleached concrete, gulls overhead');
  });

  it('refreshes prose-derived metadata even when descriptive fields are preserved', async () => {
    const id = await newWork();
    const p = await createPlace(id, { slugline: 'INT. ATTIC — DUSK', description: 'kept' });
    const merged = await mergeExtractedPlaces(id, [{
      slugline: 'INT. ATTIC — DUSK',
      description: 'ignored',
      missingFromProse: ['weather', 'palette'],
      evidence: ['"She climbed the ladder,"'],
      firstAppearance: 'Chapter 2',
    }]);
    const updated = merged.find((x) => x.id === p.id);
    expect(updated.description).toBe('kept');
    expect(updated.missingFromProse).toEqual(['weather', 'palette']);
    expect(updated.firstAppearance).toBe('Chapter 2');
  });

  it('back-fills slugline on a name-only existing place when extraction supplies one', async () => {
    const id = await newWork();
    const p = await createPlace(id, { name: 'The Atrium' });
    expect(p.slugline).toBe('');
    const merged = await mergeExtractedPlaces(id, [{
      slugline: 'INT. THE ATRIUM — DAY',
      name: 'The Atrium',
      description: 'glass dome, copper rails',
    }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].slugline).toBe('INT. THE ATRIUM — DAY');
    expect(merged[0].description).toBe('glass dome, copper rails');
  });

  it('re-indexes after slugline back-fill so a later batch entry keyed by slugline matches', async () => {
    const id = await newWork();
    await createPlace(id, { name: 'The Vault' });
    const merged = await mergeExtractedPlaces(id, [
      { slugline: 'INT. THE VAULT — NIGHT', name: 'The Vault', description: 'heavy steel doors' },
      { slugline: 'INT. THE VAULT — NIGHT', palette: 'pewter and oxblood' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe('heavy steel doors');
    expect(merged[0].palette).toBe('pewter and oxblood');
  });

  it('does not duplicate within a single batch when a new entry is referenced by both slugline and name', async () => {
    const id = await newWork();
    const merged = await mergeExtractedPlaces(id, [
      { slugline: 'INT. CHAPEL — DAWN', name: 'The Old Chapel', description: 'whitewashed walls' },
      { name: 'The Old Chapel', palette: 'bone-white and gold' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe('whitewashed walls');
    expect(merged[0].palette).toBe('bone-white and gold');
  });
});
