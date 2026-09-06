import { describe, expect, it } from 'vitest';

import {
  BIBLE_CORE_FIELDS,
  BIBLE_EXPAND_FIELDS,
  bibleEntryCompleteness,
  bibleEntryIsDescribed,
  bibleFieldIsBlank,
  expandableBibleFields,
  missingBibleFields,
  normalizeDescribeDepth,
} from './universeBibleCompleteness.js';
import { bibleUserEditableFields } from './storyBible.js';

const describedCharacter = () => {
  const groups = BIBLE_EXPAND_FIELDS.character;
  const entry = { id: 'c1', name: 'Alice' };
  for (const field of groups.strings) entry[field] = `${field} text`;
  for (const field of groups.lists) entry[field] = [{ name: 'x' }];
  entry.arcType = 'positive';
  entry.sliders = { proactivity: 7, likability: 6, competence: 8 };
  entry.psychology = {
    theoryOfControl: 'if I stay useful, nobody leaves',
    drives: {
      survival: { desire: 'a roof that is hers', fear: 'being turned out' },
      connection: { desire: 'to be kept', fear: 'being easy to replace' },
      status: { desire: 'to be counted on', fear: 'being seen as surplus' },
    },
  };
  return entry;
};

describe('missingBibleFields', () => {
  it('reports every unfilled character-sheet field at full depth', () => {
    const missing = missingBibleFields('character', { id: 'c1', name: 'Alice' });
    expect(missing).toHaveLength(expandableBibleFields('character').length);
    expect(missing).toContain('physicalDescription');
    expect(missing).toContain('colorPalette');
    expect(missing).toContain('sliders');
  });

  it('reports nothing for a fully-sheeted character', () => {
    expect(missingBibleFields('character', describedCharacter())).toEqual([]);
    expect(bibleEntryIsDescribed('character', describedCharacter())).toBe(true);
  });

  it('core depth asks only for what makes an entry renderable', () => {
    const core = {
      id: 'c1',
      name: 'Alice',
      physicalDescription: 'a', personality: 'b', background: 'c', motivations: 'd', visualNotes: 'e',
    };
    expect(missingBibleFields('character', core, { depth: 'core' })).toEqual([]);
    // The same entry is still far from a finished sheet.
    expect(missingBibleFields('character', core, { depth: 'full' }).length).toBeGreaterThan(10);
  });

  it('treats a character with only the legacy `description` alias as described', () => {
    // Migration 019 rewrites `description` → `physicalDescription`, but the
    // read-side fallback stays. Without it a pre-migration entry reads as blank
    // and gets re-described on top of text it already has.
    expect(bibleFieldIsBlank({ description: 'weathered, tall' }, 'physicalDescription')).toBe(false);
    expect(missingBibleFields('place', { description: 'a foundry' }, { depth: 'core' })).toEqual([]);
  });

  it('counts a partly-rated sliders object as unfilled', () => {
    // `sliders` is always present after sanitization with null axes, so plain
    // presence would report it filled the moment the record was written.
    expect(bibleFieldIsBlank({ sliders: { proactivity: 7, likability: null, competence: 3 } }, 'sliders')).toBe(true);
    expect(bibleFieldIsBlank({ sliders: { proactivity: 7, likability: 2, competence: 3 } }, 'sliders')).toBe(false);
  });

  it('never asks for id-bearing link fields an expand call cannot mint', () => {
    const all = Object.values(BIBLE_EXPAND_FIELDS).flatMap((groups) => [
      ...groups.strings, ...groups.lists, ...groups.enums, ...groups.objects,
    ]);
    expect(all).not.toContain('relationshipLinks');
    expect(all).not.toContain('attachments');
  });

  it('reports nothing for an unknown kind or a non-object entry', () => {
    expect(missingBibleFields('sandwich', { name: 'x' })).toEqual([]);
    expect(missingBibleFields('character', null)).toEqual([]);
  });
});

describe('bibleEntryCompleteness', () => {
  it('reports the gap and the sheet size the describe job ranks on', () => {
    const empty = bibleEntryCompleteness('place', { id: 'p1' });
    const partial = bibleEntryCompleteness('place', { id: 'p2', description: 'a foundry', era: 'late-industrial' });
    expect(empty.required).toBe(expandableBibleFields('place').length);
    expect(empty.missing).toHaveLength(empty.required);
    expect(partial.missing).toHaveLength(empty.required - 2);
    // The ratio is what the job sorts on — a place's 7-field sheet must be
    // comparable to a character's 31-field one.
    expect(partial.missing.length / partial.required).toBeLessThan(1);
  });

  it('reports a blank gap list rather than throwing on a malformed entry', () => {
    expect(bibleEntryCompleteness('place', null).missing).toEqual([]);
  });
});

describe('normalizeDescribeDepth', () => {
  it('defaults an unknown depth to full rather than silently narrowing the ask', () => {
    expect(normalizeDescribeDepth('core')).toBe('core');
    expect(normalizeDescribeDepth('full')).toBe('full');
    expect(normalizeDescribeDepth('deep')).toBe('full');
    expect(normalizeDescribeDepth(undefined)).toBe('full');
  });
});

describe('parity with the prose extractor\'s no-clobber set', () => {
  // `MERGE_CONFIG[kind].userEditable` (storyBible) and `BIBLE_EXPAND_FIELDS`
  // answer the same question — what may an LLM fill in on an existing entry? A
  // field added to one but not the other is invisible to the completeness scan
  // forever, so the delta has to be named rather than merely tolerated.
  const KNOWN_DELTA = {
    // `role` is extracted from prose but is not something the expand prompts
    // invent — a character's function in the story is the writer's call.
    character: { extractorOnly: ['role'], expandOnly: ['sliders'] },
    place: { extractorOnly: [], expandOnly: [] },
    object: { extractorOnly: [], expandOnly: [] },
  };

  for (const kind of Object.keys(BIBLE_EXPAND_FIELDS)) {
    it(`matches for ${kind} modulo the documented delta`, () => {
      const expand = new Set(expandableBibleFields(kind));
      const extractor = new Set(bibleUserEditableFields(kind));
      expect([...extractor].filter((f) => !expand.has(f)).sort())
        .toEqual([...KNOWN_DELTA[kind].extractorOnly].sort());
      expect([...expand].filter((f) => !extractor.has(f)).sort())
        .toEqual([...KNOWN_DELTA[kind].expandOnly].sort());
    });
  }
});

describe('core sets', () => {
  it('are a subset of what the expand prompts can actually fill', () => {
    for (const [kind, fields] of Object.entries(BIBLE_CORE_FIELDS)) {
      const groups = BIBLE_EXPAND_FIELDS[kind];
      const fillable = new Set([...groups.strings, ...groups.lists, ...groups.enums, ...groups.objects]);
      // A core field the expand prompt cannot fill would make the entry
      // permanently under-described and re-picked on every burn cycle.
      for (const field of fields) expect(fillable.has(field)).toBe(true);
    }
  });
});
