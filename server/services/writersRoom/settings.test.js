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
const settings = await import('./settings.js');
const { createWork } = local;
const {
  listSettings, createSetting, updateSetting, deleteSetting,
  mergeExtractedSettings, normalizeSlugline,
} = settings;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wr-settings-test-'));
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

describe('writers room — settings CRUD', () => {
  it('starts with an empty bible', async () => {
    const id = await newWork();
    expect(await listSettings(id)).toEqual([]);
  });

  it('rejects creating a setting with neither slugline nor name', async () => {
    const id = await newWork();
    await expect(createSetting(id, {})).rejects.toThrow(/slugline or a name/i);
  });

  it('rejects duplicate sluglines after normalization', async () => {
    const id = await newWork();
    await createSetting(id, { slugline: 'INT. KITCHEN — NIGHT', description: 'cozy' });
    await expect(createSetting(id, { slugline: 'int. kitchen - night' })).rejects.toThrow(/already exists/i);
  });

  it('creates and updates a setting profile', async () => {
    const id = await newWork();
    const s = await createSetting(id, { slugline: 'EXT. ROOFTOP — DAWN', description: 'pink sky' });
    expect(s.slugline).toBe('EXT. ROOFTOP — DAWN');
    expect(s.id).toMatch(/^wr-setting-/);

    const updated = await updateSetting(id, s.id, { description: 'pink sky over a copper city' });
    expect(updated.description).toBe('pink sky over a copper city');
    expect(updated.source).toBe('user');
  });

  it('deletes a setting', async () => {
    const id = await newWork();
    const s = await createSetting(id, { slugline: 'INT. ATTIC — DUSK' });
    await deleteSetting(id, s.id);
    expect(await listSettings(id)).toHaveLength(0);
  });

  it('rejects an update that would leave both slugline and name blank (name-only created)', async () => {
    // Setting was created via name only — slugline=''. Blanking the name
    // would leave the record unaddressable; the update must reject.
    const id = await newWork();
    const s = await createSetting(id, { name: 'The Glass Atrium' });
    await expect(updateSetting(id, s.id, { name: '' })).rejects.toThrow(/slugline or name/i);
  });

  it('rejects an update that would leave both slugline and name blank (slugline-only created)', async () => {
    const id = await newWork();
    const s = await createSetting(id, { slugline: 'INT. ATTIC — DUSK' });
    // Note: createSetting auto-fills name from slugline when name is omitted,
    // so we explicitly clear name first via update, then attempt to clear
    // slugline. The combined-blank invariant must still fire.
    await updateSetting(id, s.id, { name: '' });
    await expect(updateSetting(id, s.id, { slugline: '' })).rejects.toThrow(/slugline or name/i);
  });
});

describe('writers room — settings merge', () => {
  it('adds new settings from extraction', async () => {
    const id = await newWork();
    const merged = await mergeExtractedSettings(id, [
      { slugline: 'INT. KITCHEN — NIGHT', description: 'warm' },
      { slugline: 'EXT. ROOFTOP — DAWN', name: 'Dawn Rooftop', description: 'pink' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.every((s) => s.source === 'ai')).toBe(true);
  });

  it('preserves user edits when re-merging (fill-blanks-only)', async () => {
    const id = await newWork();
    const s = await createSetting(id, {
      slugline: 'INT. KITCHEN — NIGHT',
      description: 'USER VERSION — copper kettle on the stove',
    });
    expect(s.source).toBe('user');

    const merged = await mergeExtractedSettings(id, [{
      slugline: 'INT. KITCHEN — NIGHT',
      description: 'AI VERSION — generic kitchen',
      palette: 'warm amber and ochre',
      era: 'modern',
    }]);
    const refreshed = merged.find((x) => x.id === s.id);
    expect(refreshed.description).toBe('USER VERSION — copper kettle on the stove');
    expect(refreshed.palette).toBe('warm amber and ochre');
    expect(refreshed.era).toBe('modern');
  });

  it('matches an existing setting by name when the incoming entry uses slugline', async () => {
    // A user might create a setting via name only ("Eldritch Library").
    // A later analysis pass may extract the same place by slugline
    // ("INT. ELDRITCH LIBRARY — NIGHT"). The merge MUST resolve them to one
    // record — otherwise the bible silently doubles up on every re-run.
    const id = await newWork();
    await createSetting(id, { name: 'Eldritch Library' });
    const merged = await mergeExtractedSettings(id, [{
      slugline: 'INT. ELDRITCH LIBRARY — NIGHT',
      name: 'Eldritch Library',
      description: 'rows of leather spines, dust motes',
    }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe('rows of leather spines, dust motes');
  });

  it('matches an existing slugline-only setting by name on subsequent merges', async () => {
    // Inverse of the above — initial extraction landed slugline only, a
    // later extraction adds a `name`. The same place must resolve.
    const id = await newWork();
    await mergeExtractedSettings(id, [{ slugline: 'EXT. SEAWALL — DUSK' }]);
    const merged = await mergeExtractedSettings(id, [{
      name: 'EXT. SEAWALL — DUSK',
      description: 'salt-bleached concrete, gulls overhead',
    }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe('salt-bleached concrete, gulls overhead');
  });

  it('refreshes prose-derived metadata even when descriptive fields are preserved', async () => {
    const id = await newWork();
    const s = await createSetting(id, { slugline: 'INT. ATTIC — DUSK', description: 'kept' });
    const merged = await mergeExtractedSettings(id, [{
      slugline: 'INT. ATTIC — DUSK',
      description: 'ignored',
      missingFromProse: ['weather', 'palette'],
      evidence: ['"She climbed the ladder,"'],
      firstAppearance: 'Chapter 2',
    }]);
    const updated = merged.find((x) => x.id === s.id);
    expect(updated.description).toBe('kept');
    expect(updated.missingFromProse).toEqual(['weather', 'palette']);
    expect(updated.firstAppearance).toBe('Chapter 2');
  });

  it('back-fills slugline on a name-only existing setting when extraction supplies one', async () => {
    // User created a setting via name only ("The Atrium"). A later analysis
    // pass extracts the same place with a slugline. The merge MUST
    // back-fill `slugline` so storyboard scenes can match this entry by
    // slugline; otherwise setting injection silently fails.
    const id = await newWork();
    const s = await createSetting(id, { name: 'The Atrium' });
    expect(s.slugline).toBe('');
    const merged = await mergeExtractedSettings(id, [{
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
    await createSetting(id, { name: 'The Vault' });
    const merged = await mergeExtractedSettings(id, [
      { slugline: 'INT. THE VAULT — NIGHT', name: 'The Vault', description: 'heavy steel doors' },
      { slugline: 'INT. THE VAULT — NIGHT', palette: 'pewter and oxblood' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe('heavy steel doors');
    expect(merged[0].palette).toBe('pewter and oxblood');
  });

  it('does not duplicate within a single batch when a new entry is referenced by both slugline and name', async () => {
    // Within ONE merge call, the AI introduces a new setting with both
    // slugline and a distinct name, then a later entry in the same batch
    // references it via name only. Both must collapse to one record —
    // otherwise re-running analysis would silently double up.
    const id = await newWork();
    const merged = await mergeExtractedSettings(id, [
      { slugline: 'INT. CHAPEL — DAWN', name: 'The Old Chapel', description: 'whitewashed walls' },
      { name: 'The Old Chapel', palette: 'bone-white and gold' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe('whitewashed walls');
    expect(merged[0].palette).toBe('bone-white and gold');
  });
});
