import { describe, it, expect } from 'vitest';
import {
  sanitizeCharacter,
  sanitizeSetting,
  sanitizeObject,
  sanitizeBibleList,
  mergeExtractedBible,
  isBlank,
  normalizeBibleName,
  BIBLE_LIMITS,
} from './storyBible.js';

describe('storyBible — sanitizeCharacter', () => {
  it('returns null when name is blank or input is not an object', () => {
    expect(sanitizeCharacter(null)).toBeNull();
    expect(sanitizeCharacter('string')).toBeNull();
    expect(sanitizeCharacter({ name: '' })).toBeNull();
    expect(sanitizeCharacter({ name: '   ' })).toBeNull();
  });

  it('back-compat: accepts pipeline-shape `description` and migrates to `physicalDescription`', () => {
    const out = sanitizeCharacter({ name: 'Aria', description: 'tall, dark hair' });
    expect(out.physicalDescription).toBe('tall, dark hair');
  });

  it('prefers explicit `physicalDescription` over legacy `description` when both present', () => {
    const out = sanitizeCharacter({ name: 'Aria', description: 'old', physicalDescription: 'new' });
    expect(out.physicalDescription).toBe('new');
  });

  it('preserves writers-room-shape rich fields', () => {
    const out = sanitizeCharacter({
      name: 'Marcus',
      aliases: ['Marc', 'Big M'],
      role: 'antagonist',
      physicalDescription: 'broad shoulders, scar',
      personality: 'taciturn',
      background: 'ex-military',
      notes: 'do not kill',
      evidence: ['ch1: enters bar'],
      missingFromProse: ['ever named'],
      firstAppearance: 'seg-003',
      source: 'ai',
    });
    expect(out.role).toBe('antagonist');
    expect(out.aliases).toEqual(['Marc', 'Big M']);
    expect(out.evidence).toEqual(['ch1: enters bar']);
    expect(out.firstAppearance).toBe('seg-003');
    expect(out.source).toBe('ai');
  });

  it('caps long fields and array sizes', () => {
    const long = 'x'.repeat(BIBLE_LIMITS.PHYSICAL_DESCRIPTION_MAX + 100);
    const tooMany = Array.from({ length: 30 }, (_, i) => `alias${i}`);
    const out = sanitizeCharacter({ name: 'A', physicalDescription: long, aliases: tooMany });
    expect(out.physicalDescription.length).toBe(BIBLE_LIMITS.PHYSICAL_DESCRIPTION_MAX);
    expect(out.aliases.length).toBe(BIBLE_LIMITS.ALIASES_PER_ENTRY_MAX);
  });

  it('generates an id with the requested prefix when missing, preserves explicit id', () => {
    const generated = sanitizeCharacter({ name: 'A' }, { idPrefix: 'chr-' });
    expect(generated.id).toMatch(/^chr-/);
    const preserved = sanitizeCharacter({ id: 'wr-char-existing', name: 'A' });
    expect(preserved.id).toBe('wr-char-existing');
  });

  it('coerces invalid source to `user`', () => {
    expect(sanitizeCharacter({ name: 'A', source: 'evil' }).source).toBe('user');
  });

  it('drops empty / non-string aliases', () => {
    const out = sanitizeCharacter({ name: 'A', aliases: ['', '  ', null, 42, 'real'] });
    expect(out.aliases).toEqual(['real']);
  });
});

describe('storyBible — sanitizeSetting', () => {
  it('requires either name or slugline', () => {
    expect(sanitizeSetting({ description: 'x' })).toBeNull();
    expect(sanitizeSetting({ name: 'A bar' }).name).toBe('A bar');
    expect(sanitizeSetting({ slugline: 'INT. BAR — NIGHT' }).slugline).toBe('INT. BAR — NIGHT');
  });

  it('preserves all fields and caps lengths', () => {
    const out = sanitizeSetting({
      slugline: 'INT. BAR — NIGHT',
      name: 'The Foundry',
      description: 'cramped chrome bar',
      palette: 'amber, neon-red',
      era: '2049',
      weather: 'persistent rain outside',
      recurringDetails: 'broken jukebox',
      notes: 'returns in arc 2',
      evidence: ['ch1: opens here'],
    });
    expect(out.slugline).toBe('INT. BAR — NIGHT');
    expect(out.palette).toBe('amber, neon-red');
    expect(out.evidence).toEqual(['ch1: opens here']);
  });
});

describe('storyBible — sanitizeObject', () => {
  it('requires name', () => {
    expect(sanitizeObject({ description: 'x' })).toBeNull();
  });

  it('preserves significance + aliases', () => {
    const out = sanitizeObject({ name: 'The Locket', aliases: ['locket'], description: 'silver, dented', significance: 'mother\'s' });
    expect(out.name).toBe('The Locket');
    expect(out.significance).toBe("mother's");
    expect(out.aliases).toEqual(['locket']);
  });
});

describe('storyBible — sanitizeBibleList', () => {
  it('drops malformed entries and caps to ENTRIES_PER_BIBLE_MAX', () => {
    const list = [
      { name: 'A' },
      { name: '' },               // dropped (blank name)
      null,                       // dropped (non-object)
      { name: 'B', description: 'tall' },
      ...Array.from({ length: BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX + 50 }, (_, i) => ({ name: `pad-${i}` })),
    ];
    const out = sanitizeBibleList(list, 'character');
    expect(out.length).toBe(BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX);
    expect(out[0].name).toBe('A');
    expect(out[1].name).toBe('B');
  });

  it('returns [] for non-array input or unknown kind', () => {
    expect(sanitizeBibleList(null, 'character')).toEqual([]);
    expect(sanitizeBibleList([{ name: 'A' }], 'noSuchKind')).toEqual([]);
  });
});

describe('storyBible — mergeExtractedBible (characters)', () => {
  const baseExisting = () => [
    sanitizeCharacter({ id: 'c1', name: 'Aria', physicalDescription: 'tall, dark hair', source: 'user' }),
  ];

  it('fills only blank user-editable fields on an existing entry, keeping non-blank user content', () => {
    const existing = baseExisting();
    const incoming = [
      { name: 'Aria', physicalDescription: 'short, redhead', personality: 'guarded', background: 'ex-bartender' },
    ];
    const merged = mergeExtractedBible(existing, incoming, 'character');
    const aria = merged.find((c) => c.name === 'Aria');
    expect(aria.physicalDescription).toBe('tall, dark hair'); // user wins
    expect(aria.personality).toBe('guarded'); // was blank → filled
    expect(aria.background).toBe('ex-bartender');
  });

  it('inserts new characters with source=ai', () => {
    const merged = mergeExtractedBible(baseExisting(), [{ name: 'Marcus', physicalDescription: 'broad shoulders' }], 'character');
    const marcus = merged.find((c) => c.name === 'Marcus');
    expect(marcus.source).toBe('ai');
    expect(marcus.physicalDescription).toBe('broad shoulders');
  });

  it('matches by alias on the incoming side and dedupes within a batch', () => {
    const existing = [sanitizeCharacter({ id: 'c1', name: 'Aria Reyes', aliases: ['Aria', 'The Bartender'], physicalDescription: 'tall' })];
    const merged = mergeExtractedBible(existing, [
      { name: 'Aria', personality: 'guarded' }, // matches alias
      { name: 'the bartender', background: 'ex-marine' }, // also matches alias
    ], 'character');
    expect(merged.length).toBe(1);
    expect(merged[0].personality).toBe('guarded');
    expect(merged[0].background).toBe('ex-marine');
  });

  it('refreshes prose-derived fields verbatim, including null firstAppearance', () => {
    const existing = [sanitizeCharacter({ id: 'c1', name: 'Aria', physicalDescription: 'tall', firstAppearance: 'seg-001', evidence: ['old'], missingFromProse: ['old gap'] })];
    const merged = mergeExtractedBible(existing, [{ name: 'Aria', firstAppearance: null, evidence: ['new'], missingFromProse: [] }], 'character');
    expect(merged[0].firstAppearance).toBeNull();
    expect(merged[0].evidence).toEqual(['new']);
    expect(merged[0].missingFromProse).toEqual([]);
  });

  it('backfills aliases on an entry that previously had none, then reindexes', () => {
    const existing = [sanitizeCharacter({ id: 'c1', name: 'Aria', physicalDescription: 'tall' })];
    const merged = mergeExtractedBible(existing, [
      { name: 'Aria', aliases: ['Reyes'] },
      { name: 'Reyes', personality: 'sharp' }, // should resolve to Aria via the just-backfilled alias
    ], 'character');
    expect(merged.length).toBe(1);
    expect(merged[0].aliases).toEqual(['Reyes']);
    expect(merged[0].personality).toBe('sharp');
  });

  it('skips malformed incoming rows', () => {
    const merged = mergeExtractedBible([], [null, { /* no name */ }, { name: 'A' }], 'character');
    expect(merged.length).toBe(1);
    expect(merged[0].name).toBe('A');
  });

  it('refuses inserts past ENTRIES_PER_BIBLE_MAX so merged data does not silently truncate on next read', () => {
    const existing = Array.from({ length: BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX }, (_, i) => sanitizeCharacter({ name: `seed-${i}` }));
    const incoming = Array.from({ length: 5 }, (_, i) => ({ name: `new-${i}` }));
    const merged = mergeExtractedBible(existing, incoming, 'character');
    expect(merged.length).toBe(BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX);
  });
});

describe('storyBible — mergeExtractedBible (settings)', () => {
  it('matches by slugline, fills blank fields only', () => {
    const existing = [sanitizeSetting({ id: 's1', slugline: 'INT. BAR — NIGHT', description: 'cramped chrome bar', palette: '', recurringDetails: '' })];
    const merged = mergeExtractedBible(existing, [
      { slugline: 'INT. BAR — NIGHT', description: 'overwrite attempt', palette: 'amber', recurringDetails: 'jukebox' },
    ], 'setting');
    expect(merged[0].description).toBe('cramped chrome bar'); // user wins
    expect(merged[0].palette).toBe('amber');
    expect(merged[0].recurringDetails).toBe('jukebox');
  });

  it('matches with em-dash / hyphen drift on the slugline', () => {
    const existing = [sanitizeSetting({ id: 's1', slugline: 'INT. BAR — NIGHT', description: 'cramped' })];
    const merged = mergeExtractedBible(existing, [{ slugline: 'INT BAR - NIGHT', recurringDetails: 'jukebox' }], 'setting');
    expect(merged.length).toBe(1);
    expect(merged[0].recurringDetails).toBe('jukebox');
  });

  // Settings can legitimately have an empty `name` (slugline is the primary
  // identifier). Sorting by `name` would float every slugline-only entry to
  // the top AND diverge from `writersRoom/settings.js#listSettings`'s
  // `slugline || name` order. Keep the merge sort kind-aware so the API is
  // consistent and callers don't observe an ordering flip after a merge.
  it('sorts settings by slugline (or name as fallback), not by name alone', () => {
    const existing = [
      sanitizeSetting({ id: 's1', slugline: 'INT. ZINC FOUNDRY — NIGHT' }),
      sanitizeSetting({ id: 's2', name: 'Alpha Lab' }),                        // name-only
      sanitizeSetting({ id: 's3', slugline: 'EXT. BEACH — DAWN' }),
    ];
    const merged = mergeExtractedBible(existing, [], 'setting');
    // Keys (slugline || name) → 'alpha lab', 'ext. beach — dawn', 'int. zinc foundry — night'
    expect(merged.map((e) => e.slugline || e.name)).toEqual([
      'Alpha Lab',
      'EXT. BEACH — DAWN',
      'INT. ZINC FOUNDRY — NIGHT',
    ]);
  });

  it('character/object merges still sort by name (regression guard)', () => {
    const chars = [
      sanitizeCharacter({ id: 'c1', name: 'Zara', physicalDescription: 'tall' }),
      sanitizeCharacter({ id: 'c2', name: 'Alice', physicalDescription: 'short' }),
    ];
    const mergedChars = mergeExtractedBible(chars, [], 'character');
    expect(mergedChars.map((e) => e.name)).toEqual(['Alice', 'Zara']);

    const objs = [
      sanitizeObject({ id: 'o1', name: 'Zenith Coin' }),
      sanitizeObject({ id: 'o2', name: 'Amulet' }),
    ];
    const mergedObjs = mergeExtractedBible(objs, [], 'object');
    expect(mergedObjs.map((e) => e.name)).toEqual(['Amulet', 'Zenith Coin']);
  });
});

describe('storyBible — mergeExtractedBible (objects)', () => {
  it('fills description + significance only when blank', () => {
    const existing = [sanitizeObject({ id: 'o1', name: 'The Locket', description: 'silver dented', significance: '' })];
    const merged = mergeExtractedBible(existing, [{ name: 'The Locket', description: 'try overwrite', significance: 'mother\'s' }], 'object');
    expect(merged[0].description).toBe('silver dented');
    expect(merged[0].significance).toBe("mother's");
  });
});

describe('storyBible — helpers', () => {
  it('isBlank covers null, empty array, whitespace string', () => {
    expect(isBlank(null)).toBe(true);
    expect(isBlank('   ')).toBe(true);
    expect(isBlank([])).toBe(true);
    expect(isBlank('x')).toBe(false);
    expect(isBlank(['x'])).toBe(false);
  });

  it('normalizeBibleName lowercases + trims', () => {
    expect(normalizeBibleName('  Aria Reyes  ')).toBe('aria reyes');
    expect(normalizeBibleName(null)).toBe('');
  });
});
