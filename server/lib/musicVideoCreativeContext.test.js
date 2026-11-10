import { describe, it, expect } from 'vitest';
import { musicVideoCodeDirectionContext, musicVideoCreativeContext, musicVideoDirectionContext } from './musicVideoCreativeContext.js';

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

describe('musicVideoDirectionContext', () => {
  it('includes physical behavior for the lead and supporting cast', () => {
    const text = musicVideoDirectionContext({ protagonist: { name: 'Lead', stillness: 'leans left', movement: 'quick steps' },
      cast: [{ name: 'Helper', stillness: 'hands folded', movement: 'slow gait' }] });
    expect(text).toContain('stillness: leans left; movement: quick steps');
    expect(text).toContain('stillness: hands folded; movement: slow gait');
  });

  // #14069: the planner names a cast member for a shot to condition on their sheet.
  it('names every cast member even when the rest of the direction fills the bound', () => {
    const long = 'x'.repeat(300);
    const cast = Array.from({ length: 28 }, (_, i) => ({ id: `c${i}`, name: `Castmember Number ${i} ${'n'.repeat(50)}`, role: `role ${i}`, description: long, face: long }));
    const text = musicVideoDirectionContext({
      logline: long, interpretation: long,
      protagonist: { name: 'Lead', description: long, face: long, hair: long, signature: long, gesture: long, rules: Array(6).fill(long) },
      looks: Array.from({ length: 8 }, (_, i) => ({ name: `Look ${i}`, description: long, chapters: long })),
      sets: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `Set ${i}`, description: long, lighting: long })),
      cast,
    });
    for (const c of cast) expect(text).toContain(`Cast ${c.name} (${c.role})`);
  });
});

// #15639: a shot-specific bible must select an identity without changing the
// saved snapshot, erasing a face-only identity, or filtering places and props.
describe('framing-aware creative bible', () => {
  const close = 'Identity (close and medium shots, verbatim): amber irises and freckles';
  const wide = 'Identity (full length and wider, verbatim): tall figure with a red bob';
  const concept = {
    characterStyle: [close, wide, 'Rules: Keep the red bob.', 'Wardrobe options: coat'].join('\n'),
    subjects: [
      { id: 'lead', kind: 'character', name: 'Example Lead', description: 'build: tall; face: fine freckles; hair: red bob; wardrobe: blue coat; signature: white sleeve stripe' },
      { id: 'only', kind: 'character', name: 'Example Face', description: 'face: a distinctive scar' },
      { id: 'mask', kind: 'object', name: 'Example Mask', description: 'face: painted freckles; silhouette: oval' },
    ],
  };

  it.each([null, 'medium', 'close'])('keeps facial descriptions at %s scale and selects the available identity', (scale) => {
    const text = musicVideoCreativeContext(concept, { framingScale: scale });
    expect(text).toContain(close);
    expect(text.includes(wide)).toBe(scale === null);
    expect(text).toContain('face: fine freckles');
    expect(text).not.toContain('Wide framing:');
  });

  it('projects only labeled character face clauses for wide shots and preserves source data', () => {
    const original = structuredClone(concept);
    const text = musicVideoCreativeContext(concept, { framingScale: 'wide' });
    expect(text).toContain(wide);
    expect(text).not.toContain(close);
    expect(text).not.toContain('fine freckles');
    expect(text).toContain('build: tall; hair: red bob; wardrobe: blue coat; signature: white sleeve stripe');
    expect(text).toContain('face: a distinctive scar');
    expect(text).toContain('face: painted freckles');
    expect(text).toContain('Wide framing: anchor characters by full-body silhouette');
    expect(concept).toEqual(original);
    expect(musicVideoCreativeContext({ characterStyle: close }, { framingScale: 'wide' })).toContain(close);
    expect(musicVideoCreativeContext({ characterStyle: wide }, { framingScale: 'close' })).toContain(wide);
  });

  // Filtering must happen before the existing 300-character per-subject cap:
  // otherwise a long face clause consumes the wardrobe and hair budget.
  it('retains wide anchors after a long facial clause within the shared context budget', () => {
    const text = musicVideoCreativeContext({ subjects: Array.from({ length: 24 }, (_, i) => ({
      id: `c${i}`, kind: 'character', name: `Example Cast ${i}`,
      description: `face: ${'tiny freckles '.repeat(60)}; hair: red bob; wardrobe: blue coat`,
    })) }, { framingScale: 'wide' });
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text).not.toContain('tiny freckles');
    expect(text.match(/hair: red bob; wardrobe: blue coat/g)).toHaveLength(24);
    expect(text).toContain('Wide framing:');
  });
});
