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
  trimTo,
  trimToClause,
  filterCanonForIssue,
  filterCanonListForIssue,
  isCanonEntryGatedForIssue,
  canonHasRevealGated,
  revealGatedCanonRows,
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

  it('round-trips ingredientId through applyCanonExtras (set / unset / over-cap / non-string)', () => {
    // The catalog backfill stamps the catalog row id back onto the embedded
    // canon entry; the sanitizer must preserve a valid string, trim to cap,
    // and drop non-string / missing.
    const set = sanitizeCharacter({ name: 'A', ingredientId: 'cat-chr-bible-abcd1234' });
    expect(set.ingredientId).toBe('cat-chr-bible-abcd1234');

    const unset = sanitizeCharacter({ name: 'A' });
    expect(unset.ingredientId).toBeNull();

    const long = 'cat-chr-bible-' + 'a'.repeat(BIBLE_LIMITS.INGREDIENT_ID_MAX + 32);
    const trimmed = sanitizeCharacter({ name: 'A', ingredientId: long });
    expect(trimmed.ingredientId.length).toBe(BIBLE_LIMITS.INGREDIENT_ID_MAX);

    // Non-string falls back to null — the sanitizer treats anything outside
    // the contract as "no value" rather than coercing.
    expect(sanitizeCharacter({ name: 'A', ingredientId: 12345 }).ingredientId).toBeNull();
    expect(sanitizeCharacter({ name: 'A', ingredientId: { id: 'x' } }).ingredientId).toBeNull();

    // Symmetry: places + objects carry the same field through the same helper.
    expect(sanitizePlace({ name: 'P', ingredientId: 'cat-plc-bible-feed' }).ingredientId)
      .toBe('cat-plc-bible-feed');
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

  describe('relationshipLinks (#1287)', () => {
    it('defaults a missing relationshipLinks field to an empty array (legacy shape)', () => {
      expect(sanitizeCharacter({ name: 'A' }).relationshipLinks).toEqual([]);
    });

    it('coerces a non-array relationshipLinks field to an empty array', () => {
      expect(sanitizeCharacter({ name: 'A', relationshipLinks: 'nope' }).relationshipLinks).toEqual([]);
    });

    it('sanitizes a well-formed link + mints a rel- id when none supplied', () => {
      const out = sanitizeCharacter({
        name: 'A',
        relationshipLinks: [{ targetCharacterId: 'chr-bob', type: 'ally', description: 'old friends' }],
      });
      expect(out.relationshipLinks).toHaveLength(1);
      expect(out.relationshipLinks[0].id).toMatch(/^rel-/);
      expect(out.relationshipLinks[0].targetCharacterId).toBe('chr-bob');
      expect(out.relationshipLinks[0].type).toBe('ally');
      expect(out.relationshipLinks[0].description).toBe('old friends');
      expect(out.relationshipLinks[0].opposition).toBeUndefined();
    });

    it('preserves a supplied link id', () => {
      const out = sanitizeCharacter({
        name: 'A',
        relationshipLinks: [{ id: 'rel-fixed-1', targetCharacterId: 'chr-bob' }],
      });
      expect(out.relationshipLinks[0].id).toBe('rel-fixed-1');
    });

    it('drops a link with no targetCharacterId', () => {
      const out = sanitizeCharacter({
        name: 'A',
        relationshipLinks: [{ type: 'ally', description: 'dangling' }, { targetCharacterId: 'chr-bob' }],
      });
      expect(out.relationshipLinks).toHaveLength(1);
      expect(out.relationshipLinks[0].targetCharacterId).toBe('chr-bob');
    });

    it('coerces an unrecognized type to custom (keeps the link + its prose)', () => {
      const out = sanitizeCharacter({
        name: 'A',
        relationshipLinks: [{ targetCharacterId: 'chr-bob', type: 'frenemy', description: 'complicated' }],
      });
      expect(out.relationshipLinks[0].type).toBe('custom');
      expect(out.relationshipLinks[0].description).toBe('complicated');
    });

    it('defaults a missing type to custom', () => {
      const out = sanitizeCharacter({ name: 'A', relationshipLinks: [{ targetCharacterId: 'chr-bob' }] });
      expect(out.relationshipLinks[0].type).toBe('custom');
    });

    it('sanitizes opposition + coerces an unrecognized axis to custom', () => {
      const out = sanitizeCharacter({
        name: 'A',
        relationshipLinks: [{
          targetCharacterId: 'chr-bob',
          type: 'antagonist',
          opposition: { axis: 'cat/mouse', thisRole: 'hunter', targetRole: 'prey', note: 'will it flip?' },
        }],
      });
      const opp = out.relationshipLinks[0].opposition;
      expect(opp.axis).toBe('custom');
      expect(opp.thisRole).toBe('hunter');
      expect(opp.targetRole).toBe('prey');
      expect(opp.note).toBe('will it flip?');
    });

    it('keeps a recognized opposition axis verbatim', () => {
      const out = sanitizeCharacter({
        name: 'A',
        relationshipLinks: [{ targetCharacterId: 'chr-bob', opposition: { axis: 'hunter/prey' } }],
      });
      expect(out.relationshipLinks[0].opposition.axis).toBe('hunter/prey');
    });

    it('drops an opposition with no axis (collapses to absent)', () => {
      const out = sanitizeCharacter({
        name: 'A',
        relationshipLinks: [{ targetCharacterId: 'chr-bob', opposition: { thisRole: 'hunter' } }],
      });
      expect(out.relationshipLinks[0].opposition).toBeUndefined();
    });

    it('persists explicit locked true/false but drops a non-boolean', () => {
      const out = sanitizeCharacter({
        name: 'A',
        relationshipLinks: [
          { targetCharacterId: 'b', locked: true },
          { targetCharacterId: 'c', locked: false },
          { targetCharacterId: 'd', locked: 'yes' },
        ],
      });
      expect(out.relationshipLinks[0].locked).toBe(true);
      expect(out.relationshipLinks[1].locked).toBe(false);
      expect(out.relationshipLinks[2].locked).toBeUndefined();
    });

    it('caps the list at RELATIONSHIP_LINKS_PER_CHARACTER_MAX', () => {
      const tooMany = Array.from(
        { length: BIBLE_LIMITS.RELATIONSHIP_LINKS_PER_CHARACTER_MAX + 5 },
        (_, i) => ({ targetCharacterId: `chr-${i}` }),
      );
      const out = sanitizeCharacter({ name: 'A', relationshipLinks: tooMany });
      expect(out.relationshipLinks).toHaveLength(BIBLE_LIMITS.RELATIONSHIP_LINKS_PER_CHARACTER_MAX);
    });

    it('clamps over-long description + opposition fields', () => {
      const out = sanitizeCharacter({
        name: 'A',
        relationshipLinks: [{
          targetCharacterId: 'chr-bob',
          description: 'x'.repeat(BIBLE_LIMITS.RELATIONSHIP_DESCRIPTION_MAX + 50),
          opposition: { axis: 'hunter/prey', note: 'y'.repeat(BIBLE_LIMITS.RELATIONSHIP_OPPOSITION_NOTE_MAX + 50) },
        }],
      });
      expect(out.relationshipLinks[0].description.length).toBe(BIBLE_LIMITS.RELATIONSHIP_DESCRIPTION_MAX);
      expect(out.relationshipLinks[0].opposition.note.length).toBe(BIBLE_LIMITS.RELATIONSHIP_OPPOSITION_NOTE_MAX);
    });
  });

  describe('attachments (#1288)', () => {
    it('defaults a missing attachments field to an empty array (legacy shape)', () => {
      expect(sanitizeObject({ name: 'Watch' }).attachments).toEqual([]);
    });

    it('coerces a non-array attachments field to an empty array', () => {
      expect(sanitizeObject({ name: 'Watch', attachments: 'nope' }).attachments).toEqual([]);
    });

    it('sanitizes a complete attachment and mints an att- id', () => {
      const out = sanitizeObject({
        name: 'Watch',
        attachments: [{ characterId: 'chr-mara', emotion: 'grief', significance: 'her father\'s', origin: 'inherited', role: 'memento' }],
      });
      expect(out.attachments).toHaveLength(1);
      expect(out.attachments[0].id).toMatch(/^att-/);
      expect(out.attachments[0].characterId).toBe('chr-mara');
      expect(out.attachments[0].emotion).toBe('grief');
      expect(out.attachments[0].significance).toBe('her father\'s');
      expect(out.attachments[0].origin).toBe('inherited');
      expect(out.attachments[0].role).toBe('memento');
    });

    it('preserves a provided id verbatim', () => {
      const out = sanitizeObject({ name: 'Watch', attachments: [{ id: 'att-fixed-1', characterId: 'chr-mara' }] });
      expect(out.attachments[0].id).toBe('att-fixed-1');
    });

    it('drops an attachment with no characterId (meaningless link)', () => {
      const out = sanitizeObject({
        name: 'Watch',
        attachments: [{ emotion: 'grief' }, { characterId: 'chr-mara' }],
      });
      expect(out.attachments).toHaveLength(1);
      expect(out.attachments[0].characterId).toBe('chr-mara');
    });

    it('coerces an unrecognized role to custom (keeps prose intact)', () => {
      const out = sanitizeObject({
        name: 'Watch',
        attachments: [{ characterId: 'chr-mara', role: 'heirloom', significance: 'matters' }],
      });
      expect(out.attachments[0].role).toBe('custom');
      expect(out.attachments[0].significance).toBe('matters');
    });

    it('defaults a missing role to custom', () => {
      const out = sanitizeObject({ name: 'Watch', attachments: [{ characterId: 'chr-mara' }] });
      expect(out.attachments[0].role).toBe('custom');
    });

    it('persists explicit locked true/false but drops a non-boolean', () => {
      const out = sanitizeObject({
        name: 'Watch',
        attachments: [
          { characterId: 'a', locked: true },
          { characterId: 'b', locked: false },
          { characterId: 'c', locked: 'yes' },
        ],
      });
      expect(out.attachments[0].locked).toBe(true);
      expect(out.attachments[1].locked).toBe(false);
      expect(out.attachments[2].locked).toBeUndefined();
    });

    it('caps the list at ATTACHMENTS_PER_OBJECT_MAX', () => {
      const tooMany = Array.from(
        { length: BIBLE_LIMITS.ATTACHMENTS_PER_OBJECT_MAX + 5 },
        (_, i) => ({ characterId: `chr-${i}` }),
      );
      const out = sanitizeObject({ name: 'Watch', attachments: tooMany });
      expect(out.attachments).toHaveLength(BIBLE_LIMITS.ATTACHMENTS_PER_OBJECT_MAX);
    });

    it('clamps over-long prose fields', () => {
      const out = sanitizeObject({
        name: 'Watch',
        attachments: [{
          characterId: 'chr-mara',
          significance: 'x'.repeat(BIBLE_LIMITS.ATTACHMENT_SIGNIFICANCE_MAX + 50),
          origin: 'y'.repeat(BIBLE_LIMITS.ATTACHMENT_ORIGIN_MAX + 50),
          emotion: 'z'.repeat(BIBLE_LIMITS.ATTACHMENT_EMOTION_MAX + 50),
        }],
      });
      expect(out.attachments[0].significance.length).toBe(BIBLE_LIMITS.ATTACHMENT_SIGNIFICANCE_MAX);
      expect(out.attachments[0].origin.length).toBe(BIBLE_LIMITS.ATTACHMENT_ORIGIN_MAX);
      expect(out.attachments[0].emotion.length).toBe(BIBLE_LIMITS.ATTACHMENT_EMOTION_MAX);
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

describe('storyBible — trimToClause (boundary-aware prose cap)', () => {
  it('returns text untouched when it fits', () => {
    expect(trimToClause('A short logline.', 500)).toBe('A short logline.');
    expect(trimToClause('  trimmed  ', 500)).toBe('trimmed');
  });

  it('is empty for non-strings (matches trimTo)', () => {
    expect(trimToClause(null, 50)).toBe('');
    expect(trimToClause(undefined, 50)).toBe('');
    expect(trimToClause(42, 50)).toBe('');
  });

  it('clips at a sentence boundary when one falls in the last ~40% of the budget', () => {
    const text = 'First full sentence about the arc here. And then a second clause runs on well past the budget.';
    const out = trimToClause(text, 50);
    expect(out).toBe('First full sentence about the arc here.');
    expect(out.length).toBeLessThanOrEqual(50);
  });

  it('never clips mid-word — falls back to a whole-word boundary on a run-on', () => {
    // No sentence terminator within budget → must still end on a complete word,
    // not "...tracing the brand an".
    const runon = 'JUNO risks her anonymity to be recognized as author while Caroline Marsh starts tracing the brand and the buzz';
    const out = trimToClause(runon, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith(' ')).toBe(false);
    // The last token is a whole word from the source (no partial word).
    const lastWord = out.split(' ').pop();
    expect(runon.split(' ')).toContain(lastWord);
  });

  it('never returns more than max characters', () => {
    const long = 'word '.repeat(400); // 2000 chars, no sentence breaks
    expect(trimToClause(long, 100).length).toBeLessThanOrEqual(100);
  });
});

describe('storyBible — reveal-gated canon (#2178)', () => {
  describe('sanitizer field round-trip', () => {
    it('defaults reveal fields to null/absent on every kind (backward compat)', () => {
      const c = sanitizeCharacter({ name: 'Alex' });
      expect(c.revealIssue).toBeNull();
      expect(c.surfaceDescriptor).toBeNull();
      expect(c.spoiler).toBeUndefined();
      const p = sanitizePlace({ name: 'The Wing' });
      expect(p.revealIssue).toBeNull();
      expect(p.surfaceDescriptor).toBeNull();
      const o = sanitizeObject({ name: 'The Locket' });
      expect(o.revealIssue).toBeNull();
      expect(o.spoiler).toBeUndefined();
    });

    it('persists a valid revealIssue (number or numeric string) and rejects bad values', () => {
      expect(sanitizeCharacter({ name: 'A', revealIssue: 8 }).revealIssue).toBe(8);
      expect(sanitizeCharacter({ name: 'A', revealIssue: '8' }).revealIssue).toBe(8);
      expect(sanitizeCharacter({ name: 'A', revealIssue: 0 }).revealIssue).toBeNull();
      expect(sanitizeCharacter({ name: 'A', revealIssue: -3 }).revealIssue).toBeNull();
      expect(sanitizeCharacter({ name: 'A', revealIssue: 2.5 }).revealIssue).toBeNull();
      expect(sanitizeCharacter({ name: 'A', revealIssue: 'soon' }).revealIssue).toBeNull();
      expect(sanitizeCharacter({ name: 'A', revealIssue: BIBLE_LIMITS.REVEAL_ISSUE_MAX + 1 }).revealIssue).toBeNull();
    });

    it('persists explicit spoiler true/false and drops a non-boolean', () => {
      expect(sanitizeCharacter({ name: 'A', spoiler: true }).spoiler).toBe(true);
      expect(sanitizeCharacter({ name: 'A', spoiler: false }).spoiler).toBe(false);
      expect(sanitizeCharacter({ name: 'A', spoiler: 'yes' }).spoiler).toBeUndefined();
      expect(sanitizeCharacter({ name: 'A' }).spoiler).toBeUndefined();
    });

    it('caps surfaceDescriptor at its limit and collapses blank to null', () => {
      const long = 'x'.repeat(BIBLE_LIMITS.SURFACE_DESCRIPTOR_MAX + 100);
      expect(sanitizePlace({ name: 'A', surfaceDescriptor: long }).surfaceDescriptor.length)
        .toBe(BIBLE_LIMITS.SURFACE_DESCRIPTOR_MAX);
      expect(sanitizePlace({ name: 'A', surfaceDescriptor: '   ' }).surfaceDescriptor).toBeNull();
    });
  });

  describe('isCanonEntryGatedForIssue', () => {
    it('hard spoiler gates regardless of issue number', () => {
      expect(isCanonEntryGatedForIssue({ spoiler: true }, 1)).toBe(true);
      expect(isCanonEntryGatedForIssue({ spoiler: true }, 99)).toBe(true);
      expect(isCanonEntryGatedForIssue({ spoiler: true }, undefined)).toBe(true);
    });
    it('revealIssue gates only issues before it', () => {
      expect(isCanonEntryGatedForIssue({ revealIssue: 8 }, 2)).toBe(true);
      expect(isCanonEntryGatedForIssue({ revealIssue: 8 }, 8)).toBe(false);
      expect(isCanonEntryGatedForIssue({ revealIssue: 8 }, 9)).toBe(false);
    });
    it('an ungated entry is never gated', () => {
      expect(isCanonEntryGatedForIssue({ name: 'A' }, 1)).toBe(false);
      expect(isCanonEntryGatedForIssue(null, 1)).toBe(false);
    });
    it('a numeric reveal gate is not evaluable without an issue number', () => {
      expect(isCanonEntryGatedForIssue({ revealIssue: 8 }, undefined)).toBe(false);
      expect(isCanonEntryGatedForIssue({ revealIssue: 8 }, 'not-a-number')).toBe(false);
    });
  });

  describe('filterCanonListForIssue — surface substitution + drop', () => {
    it('passes ungated entries through untouched', () => {
      const list = [{ id: 'c1', name: 'Open', physicalDescription: 'tall' }];
      expect(filterCanonListForIssue(list, 'character', 1)).toEqual(list);
    });
    it('substitutes surfaceDescriptor for a gated entry and strips the secret', () => {
      const list = [{
        id: 'c1', name: 'Mara', role: 'suspect',
        physicalDescription: 'the arsonist who burned the mill',
        background: 'set the fire in Issue 8',
        revealIssue: 8,
        surfaceDescriptor: 'a quiet neighbor who keeps to herself',
      }];
      const out = filterCanonListForIssue(list, 'character', 2);
      expect(out).toHaveLength(1);
      expect(out[0].physicalDescription).toBe('a quiet neighbor who keeps to herself');
      expect(out[0].name).toBe('Mara');
      expect(out[0].role).toBe('suspect');
      expect(out[0].surfaced).toBe(true);
      // The secret fields are gone.
      expect(out[0].background).toBeUndefined();
    });
    it('drops a gated entry entirely when it has no surfaceDescriptor', () => {
      const list = [{ id: 'c1', name: 'Twist', description: 'the real killer', revealIssue: 8 }];
      expect(filterCanonListForIssue(list, 'object', 2)).toEqual([]);
    });
    it('substitutes the place description field for a gated place', () => {
      const list = [{
        id: 'p1', name: 'East Wing', slugline: 'INT. EAST WING',
        description: 'the wing where the heir is imprisoned',
        revealIssue: 5,
        surfaceDescriptor: 'the locked east wing nobody enters',
      }];
      const out = filterCanonListForIssue(list, 'place', 3);
      expect(out[0].description).toBe('the locked east wing nobody enters');
      expect(out[0].slugline).toBe('INT. EAST WING');
    });
    it('reveals the full entry at/after the reveal issue', () => {
      const list = [{ id: 'c1', name: 'Mara', physicalDescription: 'the arsonist', revealIssue: 8, surfaceDescriptor: 'a neighbor' }];
      expect(filterCanonListForIssue(list, 'character', 8)[0].physicalDescription).toBe('the arsonist');
    });
  });

  describe('filterCanonForIssue — whole bundle', () => {
    it('filters all three kinds and returns empty for a nullish canon', () => {
      expect(filterCanonForIssue(null, 1)).toEqual({ characters: [], places: [], objects: [] });
      const canon = {
        characters: [{ id: 'c', name: 'C', spoiler: true }],
        places: [{ id: 'p', name: 'P' }],
        objects: [{ id: 'o', name: 'O', revealIssue: 4, surfaceDescriptor: 'a plain box', description: 'the bomb' }],
      };
      const out = filterCanonForIssue(canon, 2);
      expect(out.characters).toEqual([]); // hard spoiler, no surface → dropped
      expect(out.places).toHaveLength(1); // ungated
      expect(out.objects[0].description).toBe('a plain box'); // surfaced
    });
  });

  describe('canonHasRevealGated + revealGatedCanonRows', () => {
    it('is false when nothing is gated, true when any entry is gated', () => {
      expect(canonHasRevealGated({ characters: [{ name: 'A' }] })).toBe(false);
      expect(canonHasRevealGated({ characters: [{ name: 'A', revealIssue: 3 }] })).toBe(true);
      expect(canonHasRevealGated({ objects: [{ name: 'O', spoiler: true }] })).toBe(true);
      expect(canonHasRevealGated(null)).toBe(false);
    });
    it('enumerates gated rows with kind/name/reveal/spoiler/fact', () => {
      const canon = {
        characters: [{ name: 'Mara', physicalDescription: 'arsonist', background: 'lit the fire', revealIssue: 8, surfaceDescriptor: 'a neighbor' }],
        objects: [{ name: 'Box', description: 'the bomb', spoiler: true }],
        places: [{ name: 'Plain Room' }],
      };
      const rows = revealGatedCanonRows(canon);
      expect(rows).toHaveLength(2);
      const mara = rows.find((r) => r.name === 'Mara');
      expect(mara.kind).toBe('character');
      expect(mara.revealIssue).toBe(8);
      expect(mara.spoiler).toBe(false);
      expect(mara.surfaceDescriptor).toBe('a neighbor');
      expect(mara.fact).toContain('arsonist');
      expect(mara.fact).toContain('lit the fire');
      const box = rows.find((r) => r.name === 'Box');
      expect(box.spoiler).toBe(true);
      expect(box.revealIssue).toBeNull();
    });
  });
});
