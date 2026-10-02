import { describe, it, expect } from 'vitest';
import { musicVideoCodeDirectionContext } from './musicVideoCreativeContext.js';

const character = (id, partCount) => ({
  id, name: id, renderer: 'svg', palette: [],
  parts: Array.from({ length: partCount }, (_, i) => ({ id: `p${i}`, shape: 'circle', x: 10, y: 10, r: 5 })),
  expressions: [], poses: [], motion: [],
});

describe('musicVideoCodeDirectionContext', () => {
  const procedural = (characters) => ({
    medium: 'procedural',
    protagonist: { name: 'Boat', movement: 'bobs on every beat' },
    world: { camera: 'slow dolly' },
    sets: [{ id: 'river', name: 'River', description: 'a neon river', imageRole: 'texture' }],
    definitions: { characters },
  });

  it('carries the rules, the set roles and each definition as parseable JSON', () => {
    const text = musicVideoCodeDirectionContext(procedural([character('boat', 2)]));
    expect(text).toContain('movement: bobs on every beat');
    expect(text).toContain('camera: slow dolly');
    expect(text).toContain('Set River (image role texture)');
    const json = text.split('\n').find((line) => line.startsWith('{"id":"boat"'));
    expect(JSON.parse(json).parts).toHaveLength(2);
  });

  it('includes whole characters only, never a truncated definition', () => {
    const text = musicVideoCodeDirectionContext(procedural([character('small', 3), character('huge', 400)]));
    expect(text.length).toBeLessThanOrEqual(8000);
    expect(text).toContain('"id":"small"');
    expect(text).not.toContain('"id":"huge"');
  });

  it('is empty for a photographic direction or one with no rules and no definitions', () => {
    expect(musicVideoCodeDirectionContext(null)).toBe('');
    expect(musicVideoCodeDirectionContext({ protagonist: { name: 'Nova', face: 'weathered' } })).toBe('');
    expect(musicVideoCodeDirectionContext({ medium: 'procedural' })).toBe('');
  });
});
