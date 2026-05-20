import { describe, it, expect } from 'vitest';
import { BIBLE_LIMITS } from './bibleLimits.js';
import {
  mergeVariations,
  mergeCanonByName,
  extractPreservedFromDraft,
  mergeExpandIntoDraft,
} from './universeBuilderExpand.js';

// Identity helper used in several lock/clear tests below.
const draftFixture = (over = {}) => ({
  starterPrompt: 'cyberpunk city',
  logline: 'L1',
  premise: 'P1',
  styleNotes: 'S1',
  influences: { embrace: ['noir'], avoid: ['high-fantasy'] },
  locked: {},
  categories: {},
  compositeSheets: [],
  characters: [],
  places: [],
  objects: [],
  llm: { provider: 'codex', model: 'gpt-5' },
  ...over,
});

describe('mergeVariations', () => {
  it('dedupes case-insensitively by label, existing first', () => {
    const out = mergeVariations(
      [{ label: 'Existing One' }],
      [{ label: 'existing one' }, { label: 'fresh' }],
    );
    expect(out.map((v) => v.label)).toEqual(['Existing One', 'fresh']);
  });

  it('drops rows missing a label from both sides (no silent dup)', () => {
    const out = mergeVariations(
      [{ label: 'a' }, { label: '' }],
      [{ label: 'a' }, { label: undefined }, { label: 'b' }],
    );
    expect(out.map((v) => v.label)).toEqual(['a', 'b']);
  });

  it('handles null/undefined inputs', () => {
    expect(mergeVariations(null, [{ label: 'x' }])).toEqual([{ label: 'x' }]);
    expect(mergeVariations([{ label: 'x' }], null)).toEqual([{ label: 'x' }]);
    expect(mergeVariations(null, null)).toEqual([]);
  });
});

describe('mergeCanonByName', () => {
  it('returns existing unchanged when fresh is empty (preserves reference)', () => {
    const existing = [{ name: 'Ashley' }];
    expect(mergeCanonByName(existing, [], 'character')).toBe(existing);
    expect(mergeCanonByName(existing, null, 'character')).toBe(existing);
  });

  it('character: trim+lowercase name collision; existing wins', () => {
    const out = mergeCanonByName(
      [{ name: 'Ashley', role: 'protagonist' }],
      [{ name: '  ashley  ', role: 'antagonist' }, { name: 'Bobby' }],
      'character',
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: 'Ashley', role: 'protagonist' });
    expect(out[1].name).toBe('Bobby');
  });

  it('character: alias matches existing primary name', () => {
    const out = mergeCanonByName(
      [{ name: 'Ashley', aliases: ['Ash'] }],
      [{ name: 'Ash', role: 'should not duplicate' }],
      'character',
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Ashley');
  });

  it('character: fresh entry registers its keys even on collision (within-batch dedupe)', () => {
    const out = mergeCanonByName(
      [{ name: 'Ashley', aliases: ['Ash'] }],
      [
        { name: 'Mr X', aliases: ['Ash'] }, // collides via alias with existing → skip
        { name: 'Ash', role: 'would otherwise slip in' }, // collides with first fresh's claimed alias
      ],
      'character',
    );
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Ashley');
  });

  it('place: slugline collision wins even with different name punctuation', () => {
    const out = mergeCanonByName(
      [{ name: 'Foundry City', slugline: 'INT. FOUNDRY CITY - DAY' }],
      [
        { name: 'Foundry-City', slugline: 'INT. FOUNDRY CITY — DAY' },
        { name: 'Other Place', slugline: 'EXT. WHARF - NIGHT' },
      ],
      'place',
    );
    expect(out).toHaveLength(2);
    expect(out[0].slugline).toBe('INT. FOUNDRY CITY - DAY');
    expect(out[1].name).toBe('Other Place');
  });

  it('place: aliases NOT used as identity key', () => {
    const out = mergeCanonByName(
      [{ name: 'Foundry City', aliases: ['Foundry'] }],
      [{ name: 'Foundry', slugline: 'INT. FOUNDRY - DAY' }],
      'place',
    );
    expect(out).toHaveLength(2);
  });

  it('caps merged output at BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX', () => {
    const cap = BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX;
    const existing = Array.from({ length: cap - 1 }, (_, i) => ({ name: `e${i}` }));
    const fresh = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}` }));
    const out = mergeCanonByName(existing, fresh, 'character');
    expect(out).toHaveLength(cap);
  });
});

describe('extractPreservedFromDraft', () => {
  it('returns only items with locked: true', () => {
    const { preservedVariations, preservedCompositeSheets } = extractPreservedFromDraft({
      categories: {
        weapons: { variations: [{ label: 'A', locked: true }, { label: 'B' }] },
        food: { variations: [{ label: 'C' }] },
      },
      compositeSheets: [
        { label: 'sheet1', locked: true },
        { label: 'sheet2' },
      ],
    });
    expect(preservedVariations).toEqual({ weapons: [{ label: 'A', locked: true }] });
    expect(preservedCompositeSheets).toEqual([{ label: 'sheet1', locked: true }]);
  });

  it('handles missing categories/compositeSheets', () => {
    expect(extractPreservedFromDraft({})).toEqual({
      preservedVariations: {},
      preservedCompositeSheets: [],
    });
    expect(extractPreservedFromDraft(null)).toEqual({
      preservedVariations: {},
      preservedCompositeSheets: [],
    });
  });
});

describe('mergeExpandIntoDraft', () => {
  it('locked scalar field keeps draft value; unlocked takes LLM value', () => {
    const draft = draftFixture({ locked: { logline: true } });
    const { expandedDraft } = mergeExpandIntoDraft(draft, {
      logline: 'LLM-overridden',
      premise: 'LLM-premise',
    });
    expect(expandedDraft.logline).toBe('L1'); // locked → draft wins
    expect(expandedDraft.premise).toBe('LLM-premise'); // unlocked → LLM wins
  });

  it('unlocked + LLM null/undefined → keep draft (absent semantics)', () => {
    const draft = draftFixture();
    const { expandedDraft } = mergeExpandIntoDraft(draft, {
      logline: null,
      premise: undefined,
      styleNotes: 'kept',
    });
    expect(expandedDraft.logline).toBe('L1');
    expect(expandedDraft.premise).toBe('P1');
    expect(expandedDraft.styleNotes).toBe('kept');
  });

  it('unlocked + LLM empty string → applies the clear', () => {
    const draft = draftFixture();
    const { expandedDraft } = mergeExpandIntoDraft(draft, {
      logline: '',
      premise: 'still there',
    });
    expect(expandedDraft.logline).toBe('');
    expect(expandedDraft.premise).toBe('still there');
  });

  it('locked variations survive a regeneration; unlocked re-merged with fresh', () => {
    const draft = draftFixture({
      categories: {
        weapons: { kind: 'object', variations: [{ label: 'sword', locked: true }, { label: 'old-bow' }] },
      },
    });
    const { expandedDraft } = mergeExpandIntoDraft(draft, {
      categories: {
        weapons: { kind: 'object', variations: [{ label: 'bow' }, { label: 'sword' /* dup, drops */ }] },
      },
    });
    // 'sword' (locked) keeps its slot at the top; 'bow' added; LLM duplicate dropped.
    expect(expandedDraft.categories.weapons.variations.map((v) => v.label))
      .toEqual(['sword', 'bow']);
    expect(expandedDraft.categories.weapons.kind).toBe('object');
  });

  it('category kind precedence: user-curated non-other survives LLM reclassification', () => {
    const draft = draftFixture({
      categories: { factions: { kind: 'characters', variations: [{ label: 'X', locked: true }] } },
    });
    const { expandedDraft } = mergeExpandIntoDraft(draft, {
      categories: { factions: { kind: 'object', variations: [] } },
    });
    expect(expandedDraft.categories.factions.kind).toBe('characters');
  });

  it('category kind precedence: existing "other" can be upgraded by fresh LLM kind', () => {
    const draft = draftFixture({
      categories: { factions: { kind: 'other', variations: [{ label: 'X', locked: true }] } },
    });
    const { expandedDraft } = mergeExpandIntoDraft(draft, {
      categories: { factions: { kind: 'characters', variations: [] } },
    });
    expect(expandedDraft.categories.factions.kind).toBe('characters');
  });

  it('locked composite sheets without a label crash on merge (pre-refactor byte-equivalence)', () => {
    // The pre-extraction handleExpand code did
    //   `new Set(preservedCompositeSheets.map((s) => s.label.toLowerCase()))`
    // which throws TypeError when a locked sheet lacks `label`. We preserve
    // that fault surface so the refactor is a behavioral no-op — the upstream
    // invariant (only `locked: true` rows reach here) means a label-less
    // preserved sheet is a producer bug, not a row to silently drop. Test
    // pins the throw so a future "defensive" rewrite is loud.
    const draft = draftFixture({
      compositeSheets: [{ locked: true /* missing label */ }],
    });
    expect(() => mergeExpandIntoDraft(draft, {})).toThrow(TypeError);
  });

  it('locked composite sheets survive; LLM dups dropped by case-insensitive label', () => {
    const draft = draftFixture({
      compositeSheets: [
        { label: 'cover', locked: true, body: 'draft' },
        { label: 'old', body: 'unlocked draft' },
      ],
    });
    const { expandedDraft } = mergeExpandIntoDraft(draft, {
      compositeSheets: [
        { label: 'COVER', body: 'LLM duplicate' },
        { label: 'splash', body: 'LLM new' },
      ],
    });
    // Locked sheet keeps its top slot + draft body; unlocked draft sheet is
    // dropped (composite-sheet merge is locks-only, not free-form preservation);
    // LLM "splash" is appended.
    expect(expandedDraft.compositeSheets.map((s) => s.label)).toEqual(['cover', 'splash']);
    expect(expandedDraft.compositeSheets[0].body).toBe('draft');
  });

  it('canon merge: existing wins on name collision; addedCanonCount reflects net-new only', () => {
    const draft = draftFixture({
      characters: [{ name: 'Ashley', role: 'protagonist' }],
    });
    const { expandedDraft, addedCanonCount, mergedCharacters } = mergeExpandIntoDraft(draft, {
      characters: [
        { name: 'ashley', role: 'antagonist' /* collides, dropped */ },
        { name: 'Bobby' /* new */ },
      ],
      places: [{ name: 'Foundry City', slugline: 'INT. FOUNDRY - DAY' }],
    });
    expect(mergedCharacters).toHaveLength(2);
    expect(expandedDraft.characters[0].role).toBe('protagonist'); // existing wins
    expect(addedCanonCount).toBe(2); // 1 char (Bobby) + 1 place (Foundry City)
  });

  it('pendingAdditions: only net-new entries, partitioned by trunk', () => {
    const draft = draftFixture({
      characters: [{ name: 'Ashley' }],
      places: [{ name: 'Wharf', slugline: 'EXT. WHARF - NIGHT' }],
    });
    const { pendingAdditions } = mergeExpandIntoDraft(draft, {
      characters: [{ name: 'Ashley' }, { name: 'Bobby' }],
      places: [{ name: 'New Place', slugline: 'INT. NEW - DAY' }],
      objects: [{ name: 'Sword' }],
    });
    expect(pendingAdditions.characters.map((c) => c.name)).toEqual(['Bobby']);
    expect(pendingAdditions.places.map((p) => p.name)).toEqual(['New Place']);
    expect(pendingAdditions.objects.map((o) => o.name)).toEqual(['Sword']);
  });

  it('pendingAdditions empty when nothing net-new', () => {
    const draft = draftFixture({ characters: [{ name: 'Ashley' }] });
    const { addedCanonCount, pendingAdditions } = mergeExpandIntoDraft(draft, {
      characters: [{ name: 'ashley' }],
    });
    expect(addedCanonCount).toBe(0);
    expect(pendingAdditions).toEqual({ characters: [], places: [], objects: [] });
  });

  it('lockedKeys lists only entries where locked[k] is truthy', () => {
    const draft = draftFixture({
      locked: { logline: true, premise: false, styleNotes: true },
    });
    const { lockedKeys } = mergeExpandIntoDraft(draft, {});
    expect(new Set(lockedKeys)).toEqual(new Set(['logline', 'styleNotes']));
  });

  it('influences locks: locked sublist keeps draft, unlocked accepts LLM clear', () => {
    const draft = draftFixture({
      locked: { influencesEmbrace: true },
      influences: { embrace: ['noir', 'cyberpunk'], avoid: ['fantasy'] },
    });
    const { expandedDraft } = mergeExpandIntoDraft(draft, {
      influences: { embrace: ['REPLACED'], avoid: [] /* explicit clear */ },
    });
    expect(expandedDraft.influences.embrace).toEqual(['noir', 'cyberpunk']);
    expect(expandedDraft.influences.avoid).toEqual([]);
  });

  it('llm fallback: missing llm in result preserves draft llm', () => {
    const draft = draftFixture({ llm: { provider: 'x', model: 'y' } });
    const a = mergeExpandIntoDraft(draft, {}).expandedDraft.llm;
    const b = mergeExpandIntoDraft(draft, { llm: { provider: 'new', model: 'z' } }).expandedDraft.llm;
    expect(a).toEqual({ provider: 'x', model: 'y' });
    expect(b).toEqual({ provider: 'new', model: 'z' });
  });

  it('result.{characters,places,objects} non-array → treated as no canon', () => {
    const draft = draftFixture({ characters: [{ name: 'Ashley' }] });
    const { expandedDraft, addedCanonCount } = mergeExpandIntoDraft(draft, {
      characters: 'not-an-array',
      places: null,
    });
    expect(expandedDraft.characters).toEqual([{ name: 'Ashley' }]);
    expect(addedCanonCount).toBe(0);
  });

  it('ensureDraftCategories opts wraps the merged categories when supplied', () => {
    const ensureDraftCategories = (cats) => ({ defaultBucket: { variations: [] }, ...cats });
    const draft = draftFixture();
    const { expandedDraft } = mergeExpandIntoDraft(draft, {
      categories: { weapons: { variations: [{ label: 'sword' }] } },
    }, { ensureDraftCategories });
    expect(Object.keys(expandedDraft.categories).sort()).toEqual(['defaultBucket', 'weapons']);
  });
});
