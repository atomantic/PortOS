import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the data deps so getDatasetVariationAxes can be exercised without a
// real universe/dataset store — it's a thin getDataset → live-subject →
// deriveVariationAxes wrapper, and the live-subject lookup is the part the
// pure-function tests above can't cover.
vi.mock('./loraDatasets.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getDataset: vi.fn(),
}));
vi.mock('./universeBuilder.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUniverse: vi.fn(),
}));

import { buildDatasetImagePrompt, deriveVariationAxes, getDatasetVariationAxes } from './loraDatasetGenerate.js';
import { getDataset } from './loraDatasets.js';
import { getUniverse } from './universeBuilder.js';

// Pure-function coverage for the kind-aware prompt builder + variation axes.
// These are the highest-risk new logic in the object/place feature: a
// regression in the subject block or negative-prompt selection would ship
// silently because the renders themselves are non-deterministic.

const UNIVERSE = { artStyle: 'gritty ink-and-wash fantasy' };

describe('buildDatasetImagePrompt', () => {
  it('renders a single-figure character prompt (default kind)', () => {
    const { prompt, negativePrompt } = buildDatasetImagePrompt(
      UNIVERSE,
      { name: 'Kessa', role: 'ranger' },
      {},
    );
    expect(prompt).toContain('Character: Kessa.');
    expect(prompt).toContain('Solo subject');
    expect(prompt).toContain('full body in frame');
    expect(negativePrompt).toContain('distorted anatomy');
    // Character branch never emits the object/location subject markers.
    expect(prompt).not.toContain('Single object only');
    expect(prompt).not.toContain('Single location focus');
  });

  it('renders a single-object prompt with the object negative prompt', () => {
    const subject = {
      name: 'Northwind Truthbreaker',
      description: 'A rune-bitten greataxe.',
      tags: ['weapon', 'relic'],
    };
    const { prompt, negativePrompt } = buildDatasetImagePrompt(UNIVERSE, subject, {}, 'objects');
    expect(prompt).toContain('Object: Northwind Truthbreaker.');
    expect(prompt).toContain('Description: A rune-bitten greataxe.');
    expect(prompt).toContain('Tags: weapon, relic.');
    expect(prompt).toContain('Single object only');
    expect(prompt).toContain('full object in frame');
    expect(negativePrompt).toContain('multiple objects');
    expect(negativePrompt).toContain('hands covering the object');
    expect(prompt).not.toContain('Character:');
  });

  it('renders a single-location prompt with the place negative prompt', () => {
    const subject = { name: 'Moonsea Shore', description: 'Black water under cold stars.' };
    const { prompt, negativePrompt } = buildDatasetImagePrompt(UNIVERSE, subject, {}, 'places');
    expect(prompt).toContain('Place: Moonsea Shore.');
    expect(prompt).toContain('Single location focus');
    expect(prompt).toContain('no prominent characters');
    expect(negativePrompt).toContain('prominent character');
    expect(negativePrompt).toContain('distorted perspective');
    expect(prompt).not.toContain('Single object only');
  });

  it('falls back to slugline + Unnamed and tolerates absent canon fields', () => {
    const { prompt } = buildDatasetImagePrompt(UNIVERSE, { slugline: 'INT. CRYPT' }, {}, 'places');
    expect(prompt).toContain('Place: INT. CRYPT.');
    const empty = buildDatasetImagePrompt(UNIVERSE, {}, {}, 'objects');
    expect(empty.prompt).toContain('Object: Unnamed.');
  });

  it('applies variation overrides to the object subject block', () => {
    const { prompt } = buildDatasetImagePrompt(
      UNIVERSE,
      { name: 'Truthbreaker' },
      { view: 'top-down view', expression: 'warm firelight', outfit: 'weathered wooden table' },
      'objects',
    );
    expect(prompt).toContain('top-down view');
    expect(prompt).toContain('warm firelight');
    expect(prompt).toContain('setting: weathered wooden table');
  });

  it('treats an unknown kind as characters', () => {
    const { negativePrompt } = buildDatasetImagePrompt(UNIVERSE, { name: 'X' }, {}, 'bogus');
    expect(negativePrompt).toContain('distorted anatomy');
  });
});

describe('deriveVariationAxes', () => {
  it('returns lighting/setting axes for objects', () => {
    const axes = deriveVariationAxes({ entryKind: 'objects' });
    expect(axes.expressions).toContain('soft studio lighting');
    expect(axes.outfits).toContain('plain studio plinth');
  });

  it('returns lighting/setting axes for places', () => {
    const axes = deriveVariationAxes({ entryKind: 'places' });
    expect(axes.expressions).toContain('clear daylight');
    expect(axes.outfits).toContain('signature environment');
  });

  it('derives character axes from canon expressions/wardrobes', () => {
    const axes = deriveVariationAxes({
      entryKind: 'characters',
      expressions: [{ name: 'smiling' }, { name: 'scowling' }],
      wardrobes: [{ name: 'battle armor' }],
    });
    expect(axes.expressions).toEqual(['smiling', 'scowling']);
    expect(axes.outfits).toEqual(['battle armor']);
  });

  it('falls back to default character axes when canon is empty', () => {
    const axes = deriveVariationAxes({});
    expect(axes.expressions.length).toBeGreaterThan(0);
    expect(axes.outfits).toEqual(['signature outfit']);
  });
});

describe('getDatasetVariationAxes', () => {
  beforeEach(() => {
    getDataset.mockReset();
    getUniverse.mockReset();
  });

  it('returns lighting/setting axes for an object subject', async () => {
    getDataset.mockResolvedValue({ character: { entryKind: 'objects', universeId: 'u1', entryId: 'o1' } });
    getUniverse.mockResolvedValue({ objects: [{ id: 'o1', name: 'Runed Blade' }] });

    const axes = await getDatasetVariationAxes('ds1');
    expect(axes.expressions).toContain('soft studio lighting');
    expect(axes.outfits).toContain('plain studio plinth');
  });

  it('derives character axes from the live canon subject', async () => {
    getDataset.mockResolvedValue({ character: { entryKind: 'characters', universeId: 'u1', entryId: 'c1' } });
    getUniverse.mockResolvedValue({
      characters: [{ id: 'c1', name: 'Kessa', expressions: [{ name: 'smiling' }], wardrobes: [{ name: 'ranger cloak' }] }],
    });

    const axes = await getDatasetVariationAxes('ds1');
    expect(axes.expressions).toEqual(['smiling']);
    expect(axes.outfits).toEqual(['ranger cloak']);
  });

  it('throws 409 when the subject was deleted from the universe', async () => {
    getDataset.mockResolvedValue({ character: { entryKind: 'places', universeId: 'u1', entryId: 'gone' } });
    getUniverse.mockResolvedValue({ places: [] });

    await expect(getDatasetVariationAxes('ds1')).rejects.toMatchObject({ status: 409 });
  });
});
