import { describe, it, expect } from 'vitest';
import {
  normalizeSlugline,
  normCharKey,
  buildCharByKey,
  matchSceneCharacters,
  buildPlaceByKey,
  matchScenePlace,
  buildScenePrompt,
  __testing,
} from './scenePrompt.js';

describe('scenePrompt — normalizeSlugline', () => {
  it('collapses em/en/hyphen + punctuation + spaces so equivalent sluglines match', () => {
    const a = normalizeSlugline('INT. KITCHEN — NIGHT');
    const b = normalizeSlugline('INT. KITCHEN – NIGHT');
    const c = normalizeSlugline('INT. KITCHEN - NIGHT');
    const d = normalizeSlugline('INT KITCHEN NIGHT');
    expect(a).toBe('INT KITCHEN NIGHT');
    expect(b).toBe('INT KITCHEN NIGHT');
    expect(c).toBe('INT KITCHEN NIGHT');
    expect(d).toBe('INT KITCHEN NIGHT');
  });

  it('uppercases and collapses whitespace', () => {
    expect(normalizeSlugline('int. kitchen — night')).toBe(normalizeSlugline('INT.    KITCHEN  —  NIGHT'));
  });

  it('handles falsy input', () => {
    expect(normalizeSlugline('')).toBe('');
    expect(normalizeSlugline(null)).toBe('');
    expect(normalizeSlugline(undefined)).toBe('');
  });
});

describe('scenePrompt — normCharKey', () => {
  it('strips leading "the " and lowercases', () => {
    expect(normCharKey('The Bartender')).toBe('bartender');
    expect(normCharKey('ARIA')).toBe('aria');
    expect(normCharKey('  Aria Reyes  ')).toBe('aria reyes');
  });
});

describe('scenePrompt — buildCharByKey + matchSceneCharacters', () => {
  const cast = [
    { id: 'c1', name: 'Aria Reyes', aliases: ['Aria', 'The Bartender'], physicalDescription: 'tall, dark hair' },
    { id: 'c2', name: 'Marcus', aliases: [], physicalDescription: 'broad shoulders' },
  ];

  it('indexes by name AND aliases', () => {
    const map = buildCharByKey(cast);
    expect(map.get('aria reyes')?.id).toBe('c1');
    expect(map.get('aria')?.id).toBe('c1');
    expect(map.get('bartender')?.id).toBe('c1'); // alias lookup also strips "the "
    expect(map.get('marcus')?.id).toBe('c2');
  });

  it('matches LLM scene names via either canonical name or alias, dedupes, preserves order', () => {
    const map = buildCharByKey(cast);
    const matched = matchSceneCharacters(['ARIA', 'Marcus', 'aria'], map);
    expect(matched.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('returns [] for empty / non-array input', () => {
    expect(matchSceneCharacters([], new Map())).toEqual([]);
    expect(matchSceneCharacters(null, new Map())).toEqual([]);
    expect(matchSceneCharacters(undefined, new Map())).toEqual([]);
  });
});

describe('scenePrompt — buildPlaceByKey + matchScenePlace', () => {
  const settings = [
    { id: 's1', slugline: 'INT. KITCHEN — NIGHT', description: 'cramped tile', palette: 'amber' },
    { id: 's2', name: 'EXT. ROOFTOP', slugline: '', description: 'wind-swept' },
  ];

  it('keys by slugline (preferred) then name (fallback)', () => {
    const map = buildPlaceByKey(settings);
    expect(map.get(normalizeSlugline('INT. KITCHEN — NIGHT'))?.id).toBe('s1');
    expect(map.get(normalizeSlugline('EXT. ROOFTOP'))?.id).toBe('s2');
  });

  it('matches with em-dash / hyphen drift', () => {
    const map = buildPlaceByKey(settings);
    expect(matchScenePlace('INT KITCHEN - NIGHT', map)?.id).toBe('s1');
    expect(matchScenePlace('int kitchen — night', map)?.id).toBe('s1');
  });

  it('returns null when slugline is empty or unmatched', () => {
    const map = buildPlaceByKey(settings);
    expect(matchScenePlace('', map)).toBeNull();
    expect(matchScenePlace('INT. SUBMARINE — DAWN', map)).toBeNull();
  });
});

describe('scenePrompt — buildScenePrompt', () => {
  const baseScene = { visualPrompt: 'wide shot of two figures squaring up across the bar' };

  it('emits style → title → setting → featuring → visual in order', () => {
    const out = buildScenePrompt(
      'Neon Saints',
      baseScene,
      [{ name: 'Aria', physicalDescription: 'tall, dark hair' }],
      'noir, rain-soaked, sodium street lights',
      { description: 'cramped chrome bar', palette: 'amber', recurringDetails: 'broken jukebox in corner' },
    );
    expect(out.indexOf('noir, rain-soaked, sodium street lights'))
      .toBeLessThan(out.indexOf('Neon Saints'));
    expect(out.indexOf('Neon Saints'))
      .toBeLessThan(out.indexOf('cramped chrome bar'));
    expect(out.indexOf('cramped chrome bar'))
      .toBeLessThan(out.indexOf('Featuring — Aria'));
    expect(out.indexOf('Featuring — Aria'))
      .toBeLessThan(out.indexOf('wide shot of two figures'));
  });

  it('prepends INT/EXT + time-of-day before the setting description (Cluster A)', () => {
    const out = buildScenePrompt(
      '',
      baseScene,
      [],
      '',
      { description: 'cramped chrome bar', intExt: 'INT', timeOfDay: 'night' },
    );
    expect(out).toContain('Interior, night.');
    expect(out.indexOf('Interior, night.'))
      .toBeLessThan(out.indexOf('cramped chrome bar'));
  });

  it('honors only one of intExt / timeOfDay if the other is null', () => {
    const intOnly = buildScenePrompt('', baseScene, [], '', { description: 'bar', intExt: 'EXT', timeOfDay: null });
    expect(intOnly).toContain('Exterior.');
    expect(intOnly).not.toContain(',');

    const todOnly = buildScenePrompt('', baseScene, [], '', { description: 'bar', intExt: null, timeOfDay: 'dawn' });
    expect(todOnly).toContain('dawn.');
    expect(todOnly).not.toContain('Interior');
    expect(todOnly).not.toContain('Exterior');
  });

  it('emits no metadata fragment when both fields are missing (legacy settings)', () => {
    const out = buildScenePrompt('', baseScene, [], '', { description: 'bar' });
    expect(out).not.toContain('Interior');
    expect(out).not.toContain('Exterior');
  });

  it('accepts pipeline-flavored characters (description in lieu of physicalDescription)', () => {
    const out = buildScenePrompt(
      'Series',
      baseScene,
      [{ name: 'Aria', description: 'tall, dark hair' }],
      '',
      null,
    );
    expect(out).toContain('Featuring — Aria: tall, dark hair');
  });

  it('skips characters with no visual descriptor (avoids "Aria: " junk fragments)', () => {
    const out = buildScenePrompt('S', baseScene, [{ name: 'Aria' }], '', null);
    expect(out).not.toContain('Featuring');
  });

  it('drops palette + recurringDetails before description when budget runs out', () => {
    // Reserve space for `description` (20) + a separator + the prefix-less
    // setting baseline, but NOT enough for `Palette: AMBER.` (15) on top.
    const huge = 'X'.repeat(__testing.PROMPT_MAX - 30);
    const out = buildScenePrompt(
      '',
      { visualPrompt: huge },
      [],
      '',
      { description: 'baseline description', palette: 'AMBER', recurringDetails: 'broken jukebox' },
    );
    expect(out).toContain(huge);
    expect(out).toContain('baseline description');
    expect(out).not.toContain('Palette');
    expect(out).not.toContain('broken jukebox');
  });

  it('drops characters one-by-one to fit budget, in order', () => {
    const cast = [
      { name: 'A', physicalDescription: 'X'.repeat(800) },
      { name: 'B', physicalDescription: 'short' },
    ];
    const out = buildScenePrompt('', baseScene, cast, '', null);
    expect(out).toContain('A: ');
    // 'B: short' is small enough to fit alongside A, so both should appear.
    expect(out).toContain('B: short');
  });

  it('caps total length at PROMPT_MAX', () => {
    const out = buildScenePrompt(
      'X'.repeat(500),
      { visualPrompt: 'Y'.repeat(3000) },
      [],
      'Z'.repeat(500),
      null,
    );
    expect(out.length).toBeLessThanOrEqual(__testing.PROMPT_MAX);
  });

  it('falls back to scene.description when visualPrompt is missing (pipeline call shape)', () => {
    const out = buildScenePrompt('S', { description: 'a dim room' }, [], '', null);
    expect(out).toContain('a dim room');
  });

  it('returns empty string for fully empty inputs', () => {
    expect(buildScenePrompt('', {}, [], '', null)).toBe('');
  });
});
