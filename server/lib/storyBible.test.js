import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from './mockPathsDataRoot.js';

let tempRoot;

// Mock PATHS.data so the factory writes into a temp dir per test. `tempRoot`
// is a `let` that beforeEach reassigns — the function form of dataRoot makes
// the Proxy re-read it on every PATHS access so each test sees its own dir.
vi.mock('./fileUtils.js', async () => {
  const actual = await vi.importActual('./fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tempRoot });
});

const storyBible = await import('./storyBible.js');
const {
  sanitizeCharacter,
  sanitizePlace,
  sanitizeObject,
  sanitizeBibleList,
  mergeExtractedBible,
  isBlank,
  normalizeBibleName,
  normalizeSlugline,
  findBibleEntryByName,
  BIBLE_LIMITS,
  BIBLE_KIND,
  createBibleStore,
  pruneStaleReferenceSheets,
  mergePreservedSheetPointers,
  stripCanonControlFields,
  CANON_CONTROL_FIELDS,
  SERVER_OWNED_CHARACTER_FIELDS,
} = storyBible;

const WORK_ID = 'wr-work-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('storyBible — sanitizeCharacter', () => {
  it('returns null when name is blank or input is not an object', () => {
    expect(sanitizeCharacter(null)).toBeNull();
    expect(sanitizeCharacter('string')).toBeNull();
    expect(sanitizeCharacter({ name: '' })).toBeNull();
    expect(sanitizeCharacter({ name: '   ' })).toBeNull();
  });

  it('lifts the legacy `description` alias into `physicalDescription` on read', () => {
    const out = sanitizeCharacter({ name: 'Aria', description: 'tall, dark hair' });
    expect(out.physicalDescription).toBe('tall, dark hair');
    expect(out).not.toHaveProperty('description');
  });

  it('prefers `physicalDescription` when both fields are present', () => {
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

  // ---- Universe-as-Canon extras: prompt / tags / locked / source / sourceSeriesId ----

  it('accepts Universe-as-Canon extras: prompt + tags + sourceSeriesId', () => {
    const out = sanitizeCharacter({
      name: 'Alex',
      prompt: 'field lead detective, expressive face, short jacket',
      tags: ['protagonist', 'detective'],
      sourceSeriesId: 'ser-1234',
    });
    expect(out.prompt).toBe('field lead detective, expressive face, short jacket');
    expect(out.tags).toEqual(['protagonist', 'detective']);
    expect(out.sourceSeriesId).toBe('ser-1234');
  });

  it('persists locked: true and accepts the new source vocabulary', () => {
    const out = sanitizeCharacter({ name: 'Alex', locked: true, source: 'series-extract' });
    expect(out.locked).toBe(true);
    expect(out.source).toBe('series-extract');
  });

  it('preserves explicit true/false on locked and omits other shapes', () => {
    // applyCanonExtras now persists explicit `locked: false` so the
    // universe-builder lock-by-default contract can round-trip an unlock.
    // Anything else (truthy non-bool, missing) still collapses to absent so
    // writers-room callers that never set the flag stay on the legacy shape.
    expect(sanitizeCharacter({ name: 'A', locked: false }).locked).toBe(false);
    expect(sanitizeCharacter({ name: 'A', locked: 'yes' }).locked).toBeUndefined();
    expect(sanitizeCharacter({ name: 'A', locked: 1 }).locked).toBeUndefined();
    expect(sanitizeCharacter({ name: 'A' }).locked).toBeUndefined();
  });

  it('caps tags + prompt + sourceSeriesId at their limits', () => {
    const longPrompt = 'p'.repeat(BIBLE_LIMITS.PROMPT_MAX + 50);
    const tooManyTags = Array.from({ length: BIBLE_LIMITS.TAGS_PER_ENTRY_MAX + 5 }, (_, i) => `tag-${i}`);
    const longSrc = 's'.repeat(BIBLE_LIMITS.SOURCE_SERIES_ID_MAX + 10);
    const out = sanitizeCharacter({
      name: 'A', prompt: longPrompt, tags: tooManyTags, sourceSeriesId: longSrc,
    });
    expect(out.prompt.length).toBe(BIBLE_LIMITS.PROMPT_MAX);
    expect(out.tags.length).toBe(BIBLE_LIMITS.TAGS_PER_ENTRY_MAX);
    expect(out.sourceSeriesId.length).toBe(BIBLE_LIMITS.SOURCE_SERIES_ID_MAX);
  });

  it('extras apply identically to settings + objects', () => {
    const s = sanitizePlace({ name: 'Bubble Room', tags: ['indoor'], prompt: 'pastel lab', locked: true });
    expect(s.tags).toEqual(['indoor']);
    expect(s.prompt).toBe('pastel lab');
    expect(s.locked).toBe(true);
    const o = sanitizeObject({ name: 'Ward Tape', tags: ['prop', 'recurring'], prompt: 'striped tape coil', source: 'manual' });
    expect(o.tags).toEqual(['prop', 'recurring']);
    expect(o.prompt).toBe('striped tape coil');
    expect(o.source).toBe('manual');
  });

  describe('primaryImageRef (Cluster A)', () => {
    it('returns null when not set', () => {
      const out = sanitizeCharacter({ name: 'A', imageRefs: ['a.png'] });
      expect(out.primaryImageRef).toBeNull();
    });

    it('persists a valid pointer that matches one of imageRefs[]', () => {
      const out = sanitizeCharacter({
        name: 'A',
        imageRefs: ['a.png', 'b.png'],
        primaryImageRef: 'b.png',
      });
      expect(out.primaryImageRef).toBe('b.png');
    });

    it('auto-clears a stale pointer when the target was removed from imageRefs[]', () => {
      const out = sanitizeCharacter({
        name: 'A',
        imageRefs: ['a.png'],
        primaryImageRef: 'ghost.png',
      });
      expect(out.primaryImageRef).toBeNull();
    });

    it('rejects non-string pointers without throwing', () => {
      const out = sanitizeCharacter({ name: 'A', imageRefs: ['a.png'], primaryImageRef: 123 });
      expect(out.primaryImageRef).toBeNull();
    });

    it('applies identically to settings and objects', () => {
      const s = sanitizePlace({
        name: 'Bar',
        imageRefs: ['plate.png'],
        primaryImageRef: 'plate.png',
      });
      expect(s.primaryImageRef).toBe('plate.png');
      const o = sanitizeObject({
        name: 'Watch',
        imageRefs: ['watch1.png', 'watch2.png'],
        primaryImageRef: 'watch2.png',
      });
      expect(o.primaryImageRef).toBe('watch2.png');
    });
  });

  describe('wardrobes (Cluster A)', () => {
    it('defaults to an empty array when omitted', () => {
      const out = sanitizeCharacter({ name: 'A' });
      expect(out.wardrobes).toEqual([]);
    });

    it('sanitizes well-formed wardrobe entries + assigns ids', () => {
      const out = sanitizeCharacter({
        name: 'Don Carlos',
        wardrobes: [
          { name: 'Wedding', description: 'cream silk suit, gold pocket watch' },
          { name: 'Backalley', description: 'worn leather jacket, scuffed boots' },
        ],
      });
      expect(out.wardrobes).toHaveLength(2);
      expect(out.wardrobes[0].name).toBe('Wedding');
      expect(out.wardrobes[0].description).toBe('cream silk suit, gold pocket watch');
      expect(out.wardrobes[0].id).toMatch(/^wd-/);
      expect(out.wardrobes[0].id).not.toBe(out.wardrobes[1].id);
    });

    it('preserves caller-supplied ids (round-trip after a PATCH)', () => {
      const out = sanitizeCharacter({
        name: 'Aria',
        wardrobes: [{ id: 'wd-fixed-1', name: 'Tactical' }],
      });
      expect(out.wardrobes[0].id).toBe('wd-fixed-1');
    });

    it('drops entries with no name (the only required field)', () => {
      const out = sanitizeCharacter({
        name: 'Aria',
        wardrobes: [
          { description: 'no name on this one' },
          { name: 'Real Wardrobe', description: 'has a name' },
        ],
      });
      expect(out.wardrobes).toHaveLength(1);
      expect(out.wardrobes[0].name).toBe('Real Wardrobe');
    });

    it('caps the list at BIBLE_LIMITS.WARDROBES_PER_CHARACTER_MAX', () => {
      const tooMany = Array.from({ length: BIBLE_LIMITS.WARDROBES_PER_CHARACTER_MAX + 5 }, (_, i) => ({
tryReadFile: vi.fn().mockResolvedValue(null),
        name: `Outfit ${i}`,
      }));
      const out = sanitizeCharacter({ name: 'A', wardrobes: tooMany });
      expect(out.wardrobes).toHaveLength(BIBLE_LIMITS.WARDROBES_PER_CHARACTER_MAX);
    });

    it('caps individual field lengths', () => {
      const out = sanitizeCharacter({
        name: 'A',
        wardrobes: [{
          name: 'n'.repeat(BIBLE_LIMITS.WARDROBE_NAME_MAX + 100),
          description: 'd'.repeat(BIBLE_LIMITS.WARDROBE_DESCRIPTION_MAX + 100),
        }],
      });
      expect(out.wardrobes[0].name.length).toBe(BIBLE_LIMITS.WARDROBE_NAME_MAX);
      expect(out.wardrobes[0].description.length).toBe(BIBLE_LIMITS.WARDROBE_DESCRIPTION_MAX);
    });

    it('coerces a non-array wardrobes field to an empty array', () => {
      const out = sanitizeCharacter({ name: 'A', wardrobes: 'not an array' });
      expect(out.wardrobes).toEqual([]);
    });
  });

  describe('extended character fields (novelist + graphic-novelist depth)', () => {
    it('defaults every new string field to empty + every list field to []', () => {
      const out = sanitizeCharacter({ name: 'Bare' });
      // String defaults
      expect(out.pronouns).toBe('');
      expect(out.age).toBe('');
      expect(out.coreTheme).toBe('');
      expect(out.speechAccent).toBe('');
      expect(out.speechPattern).toBe('');
      expect(out.visualNotes).toBe('');
      expect(out.silhouetteNotes).toBe('');
      expect(out.postureNotes).toBe('');
      expect(out.specialTraits).toBe('');
      expect(out.visualIdentity).toBe('');
      expect(out.motivations).toBe('');
      expect(out.likes).toBe('');
      expect(out.dislikes).toBe('');
      expect(out.mannerisms).toBe('');
      expect(out.relationships).toBe('');
      expect(out.skills).toBe('');
      // List defaults
      expect(out.stats).toEqual([]);
      expect(out.colorPalette).toEqual([]);
      expect(out.props).toEqual([]);
      expect(out.expressions).toEqual([]);
      expect(out.handGestures).toEqual([]);
      // Operational
      expect(out.referenceSheetImageRef).toBeNull();
    });

    it('round-trips a fully-populated character', () => {
      const out = sanitizeCharacter({
        name: 'Vale',
        pronouns: 'she/her',
        age: '27',
        coreTheme: 'cartographer of grief',
        speechAccent: 'clipped Edinburgh',
        speechPattern: 'rarely contracts; nautical metaphors; ends statements as questions',
        visualNotes: 'layered streetwear',
        silhouetteNotes: 'compact upper body',
        postureNotes: 'slight forward lean',
        specialTraits: 'quick hands, restless energy',
        visualIdentity: 'urban utilitarian; analog tech feel',
        motivations: 'finish the map; protect her sister',
        likes: 'thunderstorms, fresh ink',
        dislikes: 'small talk, fluorescent light',
        mannerisms: 'touches the back of her neck when lying',
        relationships: 'estranged from her father; ride-or-die with Park',
        skills: 'conversational Mandarin, sleight-of-hand',
      });
      expect(out.pronouns).toBe('she/her');
      expect(out.age).toBe('27');
      expect(out.coreTheme).toBe('cartographer of grief');
      expect(out.skills).toBe('conversational Mandarin, sleight-of-hand');
      expect(out.speechPattern).toBe('rarely contracts; nautical metaphors; ends statements as questions');
    });

    it('caps every new string field at its BIBLE_LIMITS bound', () => {
      const longs = {
        pronouns: 'p'.repeat(BIBLE_LIMITS.PRONOUNS_MAX + 5),
        age: 'a'.repeat(BIBLE_LIMITS.AGE_MAX + 5),
        coreTheme: 't'.repeat(BIBLE_LIMITS.CORE_THEME_MAX + 50),
        motivations: 'm'.repeat(BIBLE_LIMITS.MOTIVATIONS_MAX + 50),
        skills: 's'.repeat(BIBLE_LIMITS.SKILLS_MAX + 50),
      };
      const out = sanitizeCharacter({ name: 'A', ...longs });
      expect(out.pronouns.length).toBe(BIBLE_LIMITS.PRONOUNS_MAX);
      expect(out.age.length).toBe(BIBLE_LIMITS.AGE_MAX);
      expect(out.coreTheme.length).toBe(BIBLE_LIMITS.CORE_THEME_MAX);
      expect(out.motivations.length).toBe(BIBLE_LIMITS.MOTIVATIONS_MAX);
      expect(out.skills.length).toBe(BIBLE_LIMITS.SKILLS_MAX);
    });

    it('keeps the open key/value stats list (non-human characters supported)', () => {
      const out = sanitizeCharacter({
        name: 'The Reach',
        stats: [
          { label: 'Form', value: 'translucent vapor' },
          { label: 'Eyes', value: 'none (echolocates)' },
          { label: 'Limbs', value: '6 segmented' },
        ],
      });
      expect(out.stats).toHaveLength(3);
      expect(out.stats[0]).toMatchObject({ label: 'Form', value: 'translucent vapor' });
      expect(out.stats[0].id).toMatch(/^stat-/);
      expect(out.stats[2].label).toBe('Limbs');
    });

    it('stats round-trip caller-supplied id and assign UUIDs to fresh rows', () => {
      const out = sanitizeCharacter({
        name: 'A',
        stats: [
          { label: 'Form', value: 'vapor' },
          { id: 'stat-fixed-1', label: 'Limbs', value: '6' },
        ],
      });
      expect(out.stats[0].id).toMatch(/^stat-/);
      expect(out.stats[1].id).toBe('stat-fixed-1');
    });

    it('drops stats entries missing a label, caps overall list', () => {
      const tooMany = Array.from({ length: BIBLE_LIMITS.STATS_PER_CHARACTER_MAX + 5 }, (_, i) => ({ label: `s${i}`, value: 'v' }));
      const out = sanitizeCharacter({
        name: 'A',
        stats: [
          { value: 'no label' },
          ...tooMany,
        ],
      });
      // Nameless entry dropped; list capped at the limit.
      expect(out.stats).toHaveLength(BIBLE_LIMITS.STATS_PER_CHARACTER_MAX);
      expect(out.stats[0]).toMatchObject({ label: 's0', value: 'v' });
    });

    it('color palette accepts hex + role; drops nameless rows', () => {
      const out = sanitizeCharacter({
        name: 'A',
        colorPalette: [
          { name: 'amber', hex: '#f59e0b', role: 'skin' },
          { name: 'olive', hex: '', role: '' },
          { role: 'no name' },
        ],
      });
      expect(out.colorPalette).toHaveLength(2);
      expect(out.colorPalette[0]).toMatchObject({ name: 'amber', hex: '#f59e0b', role: 'skin' });
      expect(out.colorPalette[0].id).toMatch(/^color-/);
      expect(out.colorPalette[1]).toMatchObject({ name: 'olive', hex: '', role: '' });
    });

    it('props get a UUID id and round-trip caller-supplied ids', () => {
      const out = sanitizeCharacter({
        name: 'A',
        props: [
          { name: 'Radio', purpose: 'comms', materials: 'plastic + alloy' },
          { id: 'prop-fixed-1', name: 'Compass' },
        ],
      });
      expect(out.props).toHaveLength(2);
      expect(out.props[0].id).toMatch(/^prop-/);
      expect(out.props[1].id).toBe('prop-fixed-1');
      expect(out.props[0].purpose).toBe('comms');
    });

    it('expressions + handGestures drop rows without a name', () => {
      const out = sanitizeCharacter({
        name: 'A',
        expressions: [
          { name: 'neutral', description: 'baseline' },
          { description: 'no name' },
        ],
        handGestures: [
          { description: 'no name' },
          { name: 'pointing', description: 'index out' },
        ],
      });
      expect(out.expressions).toHaveLength(1);
      expect(out.expressions[0].name).toBe('neutral');
      expect(out.expressions[0].id).toMatch(/^expr-/);
      expect(out.handGestures).toHaveLength(1);
      expect(out.handGestures[0].name).toBe('pointing');
      expect(out.handGestures[0].id).toMatch(/^gesture-/);
    });

    it('referenceSheetImageRef accepts a filename and trims it', () => {
      const out = sanitizeCharacter({ name: 'A', referenceSheetImageRef: '  universe-abc-character-sheet.png  ' });
      expect(out.referenceSheetImageRef).toBe('universe-abc-character-sheet.png');
    });

    it('referenceSheetImageRef collapses to null for non-string / blank', () => {
      expect(sanitizeCharacter({ name: 'A', referenceSheetImageRef: '' }).referenceSheetImageRef).toBeNull();
      expect(sanitizeCharacter({ name: 'A', referenceSheetImageRef: '   ' }).referenceSheetImageRef).toBeNull();
      expect(sanitizeCharacter({ name: 'A', referenceSheetImageRef: 123 }).referenceSheetImageRef).toBeNull();
      expect(sanitizeCharacter({ name: 'A' }).referenceSheetImageRef).toBeNull();
    });

    it('referenceSheets map keeps valid variant entries and basename-validates each filename', () => {
      const out = sanitizeCharacter({
        name: 'A',
        referenceSheetImageRef: 'std.png',
        referenceSheets: {
          blueprint: '  blueprint.png  ',
          noir: 'noir.png',
        },
      });
      expect(out.referenceSheetImageRef).toBe('std.png');
      expect(out.referenceSheets).toEqual({ blueprint: 'blueprint.png', noir: 'noir.png' });
    });

    it('referenceSheets defaults to an empty object when absent / non-object / null', () => {
      expect(sanitizeCharacter({ name: 'A' }).referenceSheets).toEqual({});
      expect(sanitizeCharacter({ name: 'A', referenceSheets: null }).referenceSheets).toEqual({});
      expect(sanitizeCharacter({ name: 'A', referenceSheets: 'string' }).referenceSheets).toEqual({});
      expect(sanitizeCharacter({ name: 'A', referenceSheets: [] }).referenceSheets).toEqual({});
    });

    it('referenceSheets drops invalid variant ids (path traversal, uppercase, dot prefix, "standard" sentinel)', () => {
      const out = sanitizeCharacter({
        name: 'A',
        referenceSheets: {
          blueprint: 'ok.png',
          // Invalid keys: traversal, uppercase, dot prefix, the reserved
          // 'standard' sentinel (kept on the legacy field), empty string.
          '../escape': 'attack.png',
          'BadCase': 'foo.png',
          '.hidden': 'foo.png',
          'standard': 'should-stay-in-legacy-field.png',
          '': 'foo.png',
        },
      });
      expect(out.referenceSheets).toEqual({ blueprint: 'ok.png' });
    });

    it('referenceSheets drops entries whose filename fails basename validation', () => {
      const out = sanitizeCharacter({
        name: 'A',
        referenceSheets: {
          blueprint: '../escape.png',
          noir: 'foo/bar.png',
          steampunk: 'ok.png',
        },
      });
      expect(out.referenceSheets).toEqual({ steampunk: 'ok.png' });
    });

    it('REGRESSION: referenceSheetImageRef rejects path separators + traversal', () => {
      // Defense-in-depth against an LLM-extracted payload that bypassed
      // stripCanonControlFields. The runtime route serves /data/image-refs/<x>
      // — a value with separators or dot-prefix would 404 OR escape the dir.
      expect(sanitizeCharacter({ name: 'A', referenceSheetImageRef: '../etc/passwd' }).referenceSheetImageRef).toBeNull();
      expect(sanitizeCharacter({ name: 'A', referenceSheetImageRef: 'foo/bar.png' }).referenceSheetImageRef).toBeNull();
      expect(sanitizeCharacter({ name: 'A', referenceSheetImageRef: 'foo\\bar.png' }).referenceSheetImageRef).toBeNull();
      expect(sanitizeCharacter({ name: 'A', referenceSheetImageRef: '.' }).referenceSheetImageRef).toBeNull();
      expect(sanitizeCharacter({ name: 'A', referenceSheetImageRef: '..' }).referenceSheetImageRef).toBeNull();
      expect(sanitizeCharacter({ name: 'A', referenceSheetImageRef: '.hidden.png' }).referenceSheetImageRef).toBeNull();
    });
  });
});

describe('storyBible — canon control + server-owned field invariants', () => {
  // These constants are the single source of truth for "fields the LLM /
  // client shouldn't be the writer of". `stripCanonControlFields` reads
  // CANON_CONTROL_FIELDS; `updateUniverse`'s PATCH-preservation guard
  // reads SERVER_OWNED_CHARACTER_FIELDS. Pin both so a new operational
  // field added to one constant without updating the other (or its
  // consumer) gets caught.

  it('stripCanonControlFields drops every CANON_CONTROL_FIELD on an entry', () => {
    const entry = {
      id: 'c-1', createdAt: 'x', updatedAt: 'y',
      locked: true, sourceSeriesId: 'sr-1',
      imageRefs: ['a.png'], primaryImageRef: 'a.png',
      referenceSheetImageRef: 'sheet.png',
      // Non-control field — must survive.
      name: 'Vale', personality: 'alert',
    };
    const stripped = stripCanonControlFields(entry);
    for (const f of CANON_CONTROL_FIELDS) {
      expect(stripped).not.toHaveProperty(f);
    }
    expect(stripped.name).toBe('Vale');
    expect(stripped.personality).toBe('alert');
  });

  it('SERVER_OWNED_CHARACTER_FIELDS is a subset of CANON_CONTROL_FIELDS', () => {
    // The PATCH-preservation guard reads server-owned fields; the
    // strip-from-LLM guard reads control fields. Server-owned MUST be a
    // strict subset — otherwise a new server-owned field could appear
    // in literal PATCH bodies that bypass `stripCanonControlFields`.
    const ctrl = new Set(CANON_CONTROL_FIELDS);
    for (const f of SERVER_OWNED_CHARACTER_FIELDS) {
      expect(ctrl.has(f)).toBe(true);
    }
  });

  it('SERVER_OWNED_CHARACTER_FIELDS lists exactly the render-completion-stamped pointers', () => {
    // Pin the current set so a new server-owned addition is a deliberate
    // change (update both this test AND the corresponding render flow).
    expect([...SERVER_OWNED_CHARACTER_FIELDS]).toEqual([
      'referenceSheetImageRef', 'referenceSheets',
    ]);
  });
});

describe('storyBible — pruneStaleReferenceSheets', () => {
  // Lives outside the sanitizeCharacter describe because it does FS I/O
  // (intentionally outside the sanitizer's pure contract). It collapses any
  // character.referenceSheetImageRef whose underlying file is missing from
  // PATHS.imageRefs — what the universe-builder GET route surfaces to the UI.

  it('returns the input unchanged when nothing is stale', () => {
    // No character has a pointer → nothing to check, returns the same array.
    const list = [{ name: 'A' }, { name: 'B', referenceSheetImageRef: null }];
    const out = pruneStaleReferenceSheets(list);
    expect(out).toBe(list);
  });

  it('nulls out pointers whose file does not exist (without persisting back)', () => {
    const list = [
      { name: 'A', referenceSheetImageRef: 'definitely-not-on-disk.png' },
      { name: 'B' },
    ];
    const out = pruneStaleReferenceSheets(list);
    expect(out).not.toBe(list); // new array on change
    expect(out[0].referenceSheetImageRef).toBeNull();
    // Untouched character pass-through (same reference).
    expect(out[1]).toBe(list[1]);
    expect(out).toHaveLength(2);
  });

  it('passes through a non-array input', () => {
    expect(pruneStaleReferenceSheets(null)).toBeNull();
    expect(pruneStaleReferenceSheets(undefined)).toBeUndefined();
    expect(pruneStaleReferenceSheets('not array')).toBe('not array');
  });

  it('drops stale variant keys from referenceSheets without disturbing the rest of the map', () => {
    // Two variants, one resolvable on disk one not — the gone one must be
    // dropped but the still-resolvable entry must stay. The legacy field is
    // untouched in this fixture.
    const list = [{
      name: 'A',
      referenceSheets: {
        blueprint: 'gone-blueprint.png',
        // Pruner takes whatever's not on disk; this test doesn't care which
        // entries survive — only that the map is pruned per-key, not wholesale.
        steampunk: 'also-gone.png',
      },
    }];
    const out = pruneStaleReferenceSheets(list);
    expect(out).not.toBe(list);
    expect(out[0].referenceSheets).toEqual({});
    expect(out[0].name).toBe('A');
  });

  it('mergePreservedSheetPointers preserves legacy + map pointers from prev when files still resolve', () => {
    // Inject a fake FS check so the test is hermetic.
    const onDisk = new Set(['live-std.png', 'live-bp.png']);
    const checkExists = (name) => onDisk.has(name);

    // patch carries a stale legacy filename AND no map; prev has both.
    const prev = {
      id: 'c-1', name: 'Vex',
      referenceSheetImageRef: 'live-std.png',
      referenceSheets: { blueprint: 'live-bp.png' },
    };
    const patchOmits = { id: 'c-1', name: 'Vex' };
    const merged1 = mergePreservedSheetPointers(prev, patchOmits, checkExists);
    expect(merged1.referenceSheetImageRef).toBe('live-std.png');
    expect(merged1.referenceSheets).toEqual({ blueprint: 'live-bp.png' });

    // Map merge: prev's blueprint wins over the patch's stale blueprint; the
    // patch's other variant ('noir') flows through.
    const patchStale = {
      id: 'c-1', name: 'Vex',
      referenceSheetImageRef: 'old-std.png',
      referenceSheets: { blueprint: 'old-bp.png', noir: 'patch-noir.png' },
    };
    const merged2 = mergePreservedSheetPointers(prev, patchStale, checkExists);
    expect(merged2.referenceSheetImageRef).toBe('live-std.png');
    expect(merged2.referenceSheets).toEqual({ blueprint: 'live-bp.png', noir: 'patch-noir.png' });
  });

  it('mergePreservedSheetPointers falls through to the patch when prev pointer no longer resolves', () => {
    // GET-route pruner returns null when the file is gone; client PATCH
    // carries that null back. Preservation MUST not re-introduce the stale
    // pointer from cur — otherwise the UI 404s on the next render.
    const onDisk = new Set(); // nothing resolves
    const checkExists = (name) => onDisk.has(name);
    const prev = {
      id: 'c-1', name: 'A',
      referenceSheetImageRef: 'dead-std.png',
      referenceSheets: { blueprint: 'dead-bp.png' },
    };
    const patch = {
      id: 'c-1', name: 'A',
      referenceSheetImageRef: null,
      referenceSheets: {},
    };
    const merged = mergePreservedSheetPointers(prev, patch, checkExists);
    expect(merged.referenceSheetImageRef).toBeNull();
    expect(merged.referenceSheets).toEqual({});
  });

  it('mergePreservedSheetPointers is a pass-through when prev or patchChar is missing', () => {
    const checkExists = () => true;
    expect(mergePreservedSheetPointers(null, { id: 'c-1' }, checkExists)).toEqual({ id: 'c-1' });
    expect(mergePreservedSheetPointers({ id: 'c-1' }, null, checkExists)).toBeNull();
  });

  it('prunes legacy + map pointers together without blowing away unrelated fields', () => {
    const list = [{
      id: 'c-1', name: 'A', personality: 'alert',
      referenceSheetImageRef: 'gone-std.png',
      referenceSheets: { blueprint: 'gone-bp.png' },
    }];
    const out = pruneStaleReferenceSheets(list);
    expect(out[0].referenceSheetImageRef).toBeNull();
    expect(out[0].referenceSheets).toEqual({});
    expect(out[0].name).toBe('A');
    expect(out[0].personality).toBe('alert');
  });

  it('leaves an absent / empty referenceSheets untouched', () => {
    const list = [
      { name: 'A' }, // no map at all
      { name: 'B', referenceSheets: {} }, // empty map
    ];
    const out = pruneStaleReferenceSheets(list);
    expect(out).toBe(list);
  });
});

describe('storyBible — sanitizePlace', () => {
  it('requires either name or slugline', () => {
    expect(sanitizePlace({ description: 'x' })).toBeNull();
    expect(sanitizePlace({ name: 'A bar' }).name).toBe('A bar');
    expect(sanitizePlace({ slugline: 'INT. BAR — NIGHT' }).slugline).toBe('INT. BAR — NIGHT');
  });

  it('preserves all fields and caps lengths', () => {
    const out = sanitizePlace({
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

  describe('intExt + timeOfDay (Cluster A)', () => {
    it('persists valid enums', () => {
      const out = sanitizePlace({ name: 'Bar', intExt: 'INT', timeOfDay: 'night' });
      expect(out.intExt).toBe('INT');
      expect(out.timeOfDay).toBe('night');
    });

    it('normalizes case on both fields', () => {
      const out = sanitizePlace({ name: 'Bar', intExt: 'ext', timeOfDay: 'DUSK' });
      expect(out.intExt).toBe('EXT');
      expect(out.timeOfDay).toBe('dusk');
    });

    it('drops invalid enum values to null instead of throwing', () => {
      const out = sanitizePlace({ name: 'Bar', intExt: 'underwater', timeOfDay: 'midnight-snack' });
      expect(out.intExt).toBeNull();
      expect(out.timeOfDay).toBeNull();
    });

    it('treats missing/empty as null (legacy settings)', () => {
      const out = sanitizePlace({ name: 'Bar' });
      expect(out.intExt).toBeNull();
      expect(out.timeOfDay).toBeNull();
    });
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

  // ---- Universe-as-Canon lock-aware merge ----

  it('locked existing entry: skips field overwrites, appends new evidence (deduped)', () => {
    const existing = [sanitizeCharacter({
      id: 'c1', name: 'Alex', physicalDescription: 'jacket with bright piping',
      role: 'Field Lead', personality: 'calm menace', evidence: ['Issue 1 prose'],
      locked: true, source: 'series-extract',
    })];
    const merged = mergeExtractedBible(existing, [{
      name: 'Alex',
      physicalDescription: 'rewritten attempt',
      role: 'rewritten role',
      personality: 'rewritten',
      evidence: ['Issue 1 prose', 'Issue 3 prose'], // first is dupe, second is new
      firstAppearance: 'should-be-ignored',
    }], 'character');
    expect(merged.length).toBe(1);
    const alex = merged[0];
    // Narrative fields round-trip verbatim — locked entries are protected.
    expect(alex.physicalDescription).toBe('jacket with bright piping');
    expect(alex.role).toBe('Field Lead');
    expect(alex.personality).toBe('calm menace');
    expect(alex.firstAppearance).toBeNull();
    // Evidence accumulates: dedupe by case-insensitive trimmed string.
    expect(alex.evidence).toEqual(['Issue 1 prose', 'Issue 3 prose']);
    // Lock survives.
    expect(alex.locked).toBe(true);
  });

  it('autoLock option stamps locked: true + sourceSeriesId on new inserts', () => {
    const merged = mergeExtractedBible([], [{ name: 'Beta' }], 'character', {
      source: 'series-extract', autoLock: true, sourceSeriesId: 'ser-active',
    });
    expect(merged.length).toBe(1);
    expect(merged[0].locked).toBe(true);
    expect(merged[0].source).toBe('series-extract');
    expect(merged[0].sourceSeriesId).toBe('ser-active');
  });

  it('autoLock false (default) inserts unlocked entries — legacy behavior preserved', () => {
    const merged = mergeExtractedBible([], [{ name: 'Beta' }], 'character');
    expect(merged[0].locked).toBeUndefined();
    expect(merged[0].source).toBe('ai'); // legacy default
  });
});

describe('storyBible — mergeExtractedBible (places)', () => {
  it('matches by slugline, fills blank fields only', () => {
    const existing = [sanitizePlace({ id: 's1', slugline: 'INT. BAR — NIGHT', description: 'cramped chrome bar', palette: '', recurringDetails: '' })];
    const merged = mergeExtractedBible(existing, [
      { slugline: 'INT. BAR — NIGHT', description: 'overwrite attempt', palette: 'amber', recurringDetails: 'jukebox' },
    ], 'place');
    expect(merged[0].description).toBe('cramped chrome bar'); // user wins
    expect(merged[0].palette).toBe('amber');
    expect(merged[0].recurringDetails).toBe('jukebox');
  });

  it('matches with em-dash / hyphen drift on the slugline', () => {
    const existing = [sanitizePlace({ id: 's1', slugline: 'INT. BAR — NIGHT', description: 'cramped' })];
    const merged = mergeExtractedBible(existing, [{ slugline: 'INT BAR - NIGHT', recurringDetails: 'jukebox' }], 'place');
    expect(merged.length).toBe(1);
    expect(merged[0].recurringDetails).toBe('jukebox');
  });

  // Places can legitimately have an empty `name` (slugline is the primary
  // identifier). Sorting by `name` would float every slugline-only entry to
  // the top AND diverge from `writersRoom/places.js#listPlaces`'s
  // `slugline || name` order. Keep the merge sort kind-aware so the API is
  // consistent and callers don't observe an ordering flip after a merge.
  it('sorts places by slugline (or name as fallback), not by name alone', () => {
    const existing = [
      sanitizePlace({ id: 's1', slugline: 'INT. ZINC FOUNDRY — NIGHT' }),
      sanitizePlace({ id: 's2', name: 'Alpha Lab' }),                        // name-only
      sanitizePlace({ id: 's3', slugline: 'EXT. BEACH — DAWN' }),
    ];
    const merged = mergeExtractedBible(existing, [], 'place');
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

  describe('findBibleEntryByName', () => {
    const list = [
      { id: 'a', name: 'Ashley', aliases: ['Ash', 'Ash-bot'] },
      { id: 'b', name: 'Crystalline Canyon' }, // no aliases array
      { id: 'c', name: 'Reyes', aliases: null }, // null aliases tolerated
      null, // null entry tolerated
    ];

    it('matches by case-insensitive name', () => {
      expect(findBibleEntryByName(list, 'ashley')?.id).toBe('a');
      expect(findBibleEntryByName(list, '  ASHLEY  ')?.id).toBe('a');
    });

    it('matches by alias when present', () => {
      expect(findBibleEntryByName(list, 'ash')?.id).toBe('a');
      expect(findBibleEntryByName(list, 'Ash-Bot')?.id).toBe('a');
    });

    it('returns undefined when no entry matches', () => {
      expect(findBibleEntryByName(list, 'Nobody')).toBeUndefined();
    });

    it('returns undefined for blank/missing needles', () => {
      expect(findBibleEntryByName(list, '')).toBeUndefined();
      expect(findBibleEntryByName(list, '   ')).toBeUndefined();
      expect(findBibleEntryByName(list, null)).toBeUndefined();
    });

    it('returns undefined for a non-array list', () => {
      expect(findBibleEntryByName(null, 'Ashley')).toBeUndefined();
      expect(findBibleEntryByName(undefined, 'Ashley')).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// createBibleStore — factory exercised through the three real per-kind
// configs (so we cover both the single-primary-field path and the multi-
// primary settings path). Each subgroup gets a fresh temp dir.
// ---------------------------------------------------------------------------

function characterStore() {
  return createBibleStore({
    kind: BIBLE_KIND.CHARACTER,
    idPrefix: 'wr-char-',
    dedupKey: (entry) => normalizeBibleName(entry?.name),
    primaryFields: ['name'],
    editableFields: ['aliases', 'role', 'physicalDescription'],
    requireOnCreate: (patch) => (String(patch?.name || '').trim() ? null : 'Character name required'),
    conflictMessage: ({ name }) => `A character named "${name}" already exists`,
    notFoundLabel: 'Character',
    invalidIdMessage: 'Invalid character id',
  });
}

function settingStore() {
  return createBibleStore({
    kind: BIBLE_KIND.PLACE,
    idPrefix: 'wr-place-',
    dedupKey: (entry) => normalizeSlugline(entry?.slugline || entry?.name || ''),
    primaryFields: ['slugline', 'name'],
    editableFields: ['description', 'palette'],
    requireOnCreate: (patch) => {
      const sl = String(patch?.slugline || '').trim();
      const nm = String(patch?.name || '').trim();
      return sl || nm ? null : 'Setting requires either a slugline or a name';
    },
    validateAfterUpdate: (next) => {
      if (!next.slugline && !next.name) {
        const err = new Error('Setting needs slugline or name');
        err.status = 400;
        throw err;
      }
    },
    conflictMessage: ({ slugline, name }) => `A setting matching "${slugline || name}" already exists`,
    notFoundLabel: 'Setting',
    invalidIdMessage: 'Invalid setting id',
  });
}

describe('storyBible — createBibleStore (single-primary-field kind)', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'bible-factory-test-'));
  });
  afterEach(() => {
    if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('creates, lists, gets, updates, deletes', async () => {
    const store = characterStore();
    expect(await store.list(WORK_ID)).toEqual([]);

    const created = await store.create(WORK_ID, { name: 'Aria', role: 'protagonist' });
    expect(created.id).toMatch(/^wr-char-/);
    expect(created.name).toBe('Aria');
    expect(created.source).toBe('user');

    const listed = await store.list(WORK_ID);
    expect(listed).toHaveLength(1);

    const fetched = await store.get(WORK_ID, created.id);
    expect(fetched.id).toBe(created.id);

    const updated = await store.update(WORK_ID, created.id, { role: 'antagonist' });
    expect(updated.role).toBe('antagonist');

    const removed = await store.remove(WORK_ID, created.id);
    expect(removed).toEqual({ ok: true });
    expect(await store.list(WORK_ID)).toEqual([]);
  });

  it('rejects creation without the required identifier', async () => {
    const store = characterStore();
    await expect(store.create(WORK_ID, { name: '   ' })).rejects.toThrow(/name required/i);
  });

  it('rejects duplicate dedup keys at create time (case-insensitive)', async () => {
    const store = characterStore();
    await store.create(WORK_ID, { name: 'Aria' });
    await expect(store.create(WORK_ID, { name: 'aria' })).rejects.toThrow(/already exists/i);
  });

  it('rejects path-traversal-shaped work ids before any filesystem access', async () => {
    const store = characterStore();
    await expect(store.list('../../etc')).rejects.toThrow(/work id/i);
    await expect(store.create('../../etc', { name: 'X' })).rejects.toThrow(/work id/i);
    await expect(store.mergeExtracted('../../etc', [{ name: 'X' }])).rejects.toThrow(/work id/i);
  });

  it('rejects malformed entry ids on get/update/remove', async () => {
    const store = characterStore();
    await expect(store.get(WORK_ID, 'nope')).rejects.toThrow(/invalid character id/i);
    await expect(store.update(WORK_ID, 'nope', {})).rejects.toThrow(/invalid character id/i);
    await expect(store.remove(WORK_ID, 'nope')).rejects.toThrow(/invalid character id/i);
  });

  it('rejects blanking the primary identifier on update', async () => {
    const store = characterStore();
    const c = await store.create(WORK_ID, { name: 'Aria' });
    await expect(store.update(WORK_ID, c.id, { name: '' })).rejects.toThrow(/cannot be blank/i);
  });

  it('mergeExtracted inserts new entries and skips duplicates', async () => {
    const store = characterStore();
    const merged = await store.mergeExtracted(WORK_ID, [
      { name: 'Aria', role: 'protagonist' },
      { name: 'Voss', role: 'antagonist' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.every((e) => e.source === 'ai')).toBe(true);
  });
});

describe('storyBible — createBibleStore (multi-primary-field kind / settings)', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'bible-factory-settings-test-'));
  });
  afterEach(() => {
    if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('accepts either slugline or name as the primary identifier at create', async () => {
    const store = settingStore();
    const a = await store.create(WORK_ID, { slugline: 'INT. KITCHEN — NIGHT', description: 'cozy' });
    expect(a.slugline).toBe('INT. KITCHEN — NIGHT');
    // Auto-fills name from slugline when name omitted.
    expect(a.name).toBe('INT. KITCHEN — NIGHT');

    const b = await store.create(WORK_ID, { name: 'The Atrium' });
    expect(b.name).toBe('The Atrium');
    expect(b.slugline).toBe('');
  });

  it('rejects creation when both slugline and name are blank', async () => {
    const store = settingStore();
    await expect(store.create(WORK_ID, {})).rejects.toThrow(/slugline or a name/i);
  });

  it('rejects an update that blanks both name and slugline (validateAfterUpdate)', async () => {
    const store = settingStore();
    const s = await store.create(WORK_ID, { name: 'The Atrium' });
    await expect(store.update(WORK_ID, s.id, { name: '' })).rejects.toThrow(/slugline or name/i);
  });

  it('rejects duplicate-slugline create after normalization', async () => {
    const store = settingStore();
    await store.create(WORK_ID, { slugline: 'INT. KITCHEN — NIGHT' });
    await expect(
      store.create(WORK_ID, { slugline: 'int. kitchen - night' }),
    ).rejects.toThrow(/already exists/i);
  });

  it('rejects an update that would collide with another entry on dedup key', async () => {
    const store = settingStore();
    const a = await store.create(WORK_ID, { slugline: 'INT. KITCHEN — NIGHT' });
    await store.create(WORK_ID, { slugline: 'EXT. ROOFTOP — DAWN' });
    await expect(
      store.update(WORK_ID, a.id, { slugline: 'EXT. ROOFTOP — DAWN' }),
    ).rejects.toThrow(/already exists/i);
  });
});

describe('BIBLE_LIMITS client mirror', () => {
  it('matches client/src/lib/bibleLimits.js verbatim', async () => {
    // The client mirror at `client/src/lib/bibleLimits.js` exists so the
    // CharacterDetailEditor's `max:` literals can't drift from the server
    // sanitizer caps. If this fails, update the client file to match.
    const clientMirror = await import('../../client/src/lib/bibleLimits.js');
    expect(clientMirror.BIBLE_LIMITS).toEqual(BIBLE_LIMITS);
  });
});
