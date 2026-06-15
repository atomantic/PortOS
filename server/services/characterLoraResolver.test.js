import { describe, it, expect, vi, beforeEach } from 'vitest';

const listLoras = vi.fn();
vi.mock('./loras.js', () => ({ listLoras: (...args) => listLoras(...args) }));

const { resolveCharacterLoras, findLorasByCharacter } = await import('./characterLoraResolver.js');

const trainedLora = (overrides = {}) => ({
  filename: 'lora-trained-kessa-3f9a21c0.safetensors',
  name: 'Kessa (trained)',
  source: 'trained',
  character: { entryId: 'char-1', ingredientId: 'ing-1', universeId: 'uni-1', name: 'Kessa' },
  loraCompatKey: 'mflux',
  triggerWords: ['kessa'],
  recommendedScale: 1.0,
  trainedFromDatasetId: 'ds-1',
  installedAt: '2026-06-12T00:00:00Z',
  ...overrides,
});

beforeEach(() => {
  listLoras.mockReset();
});

describe('resolveCharacterLoras', () => {
  it('matches on entryId OR ingredientId', async () => {
    listLoras.mockResolvedValue([trainedLora()]);
    const byEntry = await resolveCharacterLoras([{ id: 'char-1', name: 'Kessa' }]);
    expect(byEntry).toHaveLength(1);
    expect(byEntry[0]).toMatchObject({ filename: trainedLora().filename, triggerWord: 'kessa', scale: 1.0 });
    const byIngredient = await resolveCharacterLoras([{ ingredientId: 'ing-1', name: 'Kessa' }]);
    expect(byIngredient).toHaveLength(1);
  });

  it('ignores non-trained LoRAs and unmatched characters', async () => {
    listLoras.mockResolvedValue([
      trainedLora({ source: null }),
      trainedLora({ filename: 'other.safetensors', character: { entryId: 'char-9' } }),
    ]);
    expect(await resolveCharacterLoras([{ id: 'char-1' }])).toHaveLength(0);
  });

  it('filters by compat key, tolerating bare flux2', async () => {
    listLoras.mockResolvedValue([
      trainedLora({ loraCompatKey: 'flux2-4b' }),
      trainedLora({ filename: 'bare.safetensors', loraCompatKey: 'flux2', character: { entryId: 'char-2' } }),
    ]);
    const out = await resolveCharacterLoras(
      [{ id: 'char-1' }, { id: 'char-2' }],
      { compatKey: 'flux2-4b' },
    );
    expect(out.map((l) => l.filename)).toEqual([trainedLora().filename, 'bare.safetensors']);
    // mflux render: a flux2-trained LoRA must not apply.
    expect(await resolveCharacterLoras([{ id: 'char-1' }], { compatKey: 'mflux' })).toHaveLength(0);
  });

  it('caps at max and never reuses a filename', async () => {
    listLoras.mockResolvedValue(
      ['a', 'b', 'c', 'd'].map((n, i) => trainedLora({
        filename: `${n}.safetensors`,
        character: { entryId: `char-${i}` },
      })),
    );
    const out = await resolveCharacterLoras(
      [0, 1, 2, 3].map((i) => ({ id: `char-${i}` })),
      { max: 3 },
    );
    expect(out).toHaveLength(3);
  });

  it('returns [] for empty matches without touching the lora list', async () => {
    expect(await resolveCharacterLoras([])).toEqual([]);
    expect(listLoras).not.toHaveBeenCalled();
  });

  it('never matches a non-character LoRA sharing the entry id', async () => {
    // Same entryId in two bible kinds: only the character LoRA may apply.
    listLoras.mockResolvedValue([
      trainedLora({
        filename: 'obj.safetensors',
        character: { entryId: 'char-1', entryKind: 'objects', name: 'Truthbreaker' },
      }),
    ]);
    expect(await resolveCharacterLoras([{ id: 'char-1' }])).toHaveLength(0);
  });

  it('treats a legacy sidecar with no entryKind as a character', async () => {
    listLoras.mockResolvedValue([trainedLora({ character: { entryId: 'char-1', name: 'Kessa' } })]);
    expect(await resolveCharacterLoras([{ id: 'char-1' }])).toHaveLength(1);
  });
});

describe('findLorasByCharacter', () => {
  it('returns the UI projection for a character', async () => {
    listLoras.mockResolvedValue([trainedLora(), trainedLora({ filename: 'x.safetensors', source: null })]);
    const out = await findLorasByCharacter({ entryId: 'char-1' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Kessa (trained)', datasetId: 'ds-1' });
  });

  it('requires at least one id', async () => {
    expect(await findLorasByCharacter({})).toEqual([]);
    expect(listLoras).not.toHaveBeenCalled();
  });

  it('excludes object/place LoRAs from a character lookup', async () => {
    listLoras.mockResolvedValue([
      trainedLora({ filename: 'place.safetensors', character: { entryId: 'char-1', entryKind: 'places', name: 'Shore' } }),
    ]);
    expect(await findLorasByCharacter({ entryId: 'char-1' })).toEqual([]);
  });
});
