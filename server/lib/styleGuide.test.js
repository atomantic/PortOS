import { describe, it, expect } from 'vitest';
import {
  sanitizeStyleGuide,
  renderStyleGuide,
  composeStyleNotes,
  PROSE_CRAFT_DOCTRINE,
  STYLE_GUIDE_LIMITS,
} from './styleGuide.js';

describe('sanitizeStyleGuide', () => {
  it('returns null for absent / non-object / empty input (legacy-tolerant)', () => {
    expect(sanitizeStyleGuide(undefined)).toBeNull();
    expect(sanitizeStyleGuide(null)).toBeNull();
    expect(sanitizeStyleGuide('past')).toBeNull();
    expect(sanitizeStyleGuide({})).toBeNull();
    // Every field invalid → no identifying content → null.
    expect(sanitizeStyleGuide({
      tense: 'future', povPerson: 'fourth', targetAudience: 'aliens',
      contentRating: 'NC-17', profanity: 'extreme', readingLevel: 'x', tone: 'noir',
    })).toBeNull();
  });

  it('keeps valid enum fields and drops invalid ones', () => {
    const sg = sanitizeStyleGuide({
      tense: 'present',
      povPerson: 'third-limited',
      targetAudience: 'YA',
      contentRating: 'PG-13',
      profanity: 'mild',
    });
    expect(sg).toMatchObject({
      tense: 'present',
      povPerson: 'third-limited',
      targetAudience: 'YA',
      contentRating: 'PG-13',
      profanity: 'mild',
    });
  });

  it('clamps readingLevel to [1,18] and rounds; non-finite → null', () => {
    expect(sanitizeStyleGuide({ readingLevel: 7.4 }).readingLevel).toBe(7);
    expect(sanitizeStyleGuide({ readingLevel: 99 }).readingLevel).toBe(STYLE_GUIDE_LIMITS.READING_LEVEL_MAX);
    expect(sanitizeStyleGuide({ readingLevel: 0 }).readingLevel).toBe(STYLE_GUIDE_LIMITS.READING_LEVEL_MIN);
    expect(sanitizeStyleGuide({ tense: 'past', readingLevel: 'nope' }).readingLevel).toBeNull();
  });

  it('cleans tone: trims, dedupes case-insensitively, caps', () => {
    const sg = sanitizeStyleGuide({ tone: ['Noir', '  noir ', 'hopeful', '', 42] });
    expect(sg.tone).toEqual(['Noir', 'hopeful']);
    const many = sanitizeStyleGuide({ tone: Array.from({ length: 50 }, (_, i) => `t${i}`) });
    expect(many.tone).toHaveLength(STYLE_GUIDE_LIMITS.TONES_MAX);
  });

  it('sanitizes conventions tri-state; all-unset → null conventions', () => {
    expect(sanitizeStyleGuide({ tense: 'past', conventions: {} }).conventions).toBeNull();
    const sg = sanitizeStyleGuide({
      conventions: { oxfordComma: true, spelling: 'UK', italicizeThoughts: false, junk: 1 },
    });
    expect(sg.conventions).toEqual({ oxfordComma: true, spelling: 'UK', italicizeThoughts: false });
    // A non-boolean oxfordComma is "unspecified", not false.
    const sg2 = sanitizeStyleGuide({ conventions: { oxfordComma: 'yes', spelling: 'US' } });
    expect(sg2.conventions).toEqual({ oxfordComma: null, spelling: 'US', italicizeThoughts: null });
  });

  it('survives when only one field is set', () => {
    expect(sanitizeStyleGuide({ tense: 'past' })).toMatchObject({ tense: 'past', povPerson: null });
  });

  it('cleans voice exemplars: drops empty passages, trims, caps at 3', () => {
    const sg = sanitizeStyleGuide({
      voiceExemplars: [
        { passage: '  Spare, clipped prose.  ', note: '  wry  ' },
        { passage: '', note: 'no passage' }, // dropped — empty passage
        { passage: 'x'.repeat(3000) }, // trimmed to cap, no note key
        { passage: 'four' },
        { passage: 'five' }, // over the cap of 3 → dropped
        'not an object', // ignored
      ],
    });
    expect(sg.voiceExemplars).toHaveLength(3);
    expect(sg.voiceExemplars[0]).toEqual({ passage: 'Spare, clipped prose.', note: 'wry' });
    expect(sg.voiceExemplars[1].passage).toHaveLength(STYLE_GUIDE_LIMITS.EXEMPLAR_PASSAGE_MAX);
    expect(sg.voiceExemplars[1]).not.toHaveProperty('note'); // no note → key omitted
    expect(sg.voiceExemplars[2]).toEqual({ passage: 'four' });
  });

  it('a guide with only exemplars is not collapsed to null', () => {
    const sg = sanitizeStyleGuide({ voiceExemplars: [{ passage: 'anchor prose' }] });
    expect(sg).not.toBeNull();
    expect(sg.tense).toBeNull();
    expect(sg.voiceExemplars).toHaveLength(1);
    expect(sg.voiceAntiExemplars).toEqual([]);
  });

  it('all-empty exemplar entries do not save an empty husk', () => {
    // Every field absent + exemplars that all drop → still null.
    expect(sanitizeStyleGuide({ voiceExemplars: [{ passage: '' }, 'junk'] })).toBeNull();
  });
});

describe('renderStyleGuide', () => {
  it('returns null for empty/absent guide', () => {
    expect(renderStyleGuide(null)).toBeNull();
    expect(renderStyleGuide(sanitizeStyleGuide({}))).toBeNull();
  });

  it('renders directives for the set fields', () => {
    const block = renderStyleGuide(sanitizeStyleGuide({
      tense: 'present',
      povPerson: 'first',
      targetAudience: 'YA',
      contentRating: 'PG',
      profanity: 'none',
      readingLevel: 8,
      tone: ['noir', 'hopeful'],
      conventions: { oxfordComma: true, spelling: 'UK', italicizeThoughts: true },
    }));
    expect(block).toContain('present tense');
    expect(block).toContain('first person');
    expect(block).toContain('young-adult');
    expect(block).toContain('PG');
    expect(block).toContain('no profanity');
    expect(block).toContain('grade-8');
    expect(block).toContain('noir, hopeful');
    expect(block).toContain('UK spelling');
    expect(block).toContain('Oxford');
    expect(block).toContain('italics');
  });

  it('omits the content-rating directive when rating is "custom"', () => {
    const block = renderStyleGuide(sanitizeStyleGuide({ contentRating: 'custom', tense: 'past' }));
    expect(block).not.toContain('rating');
    expect(block).toContain('past tense');
  });

  it('renders MATCH / NEVER voice blocks with passages + notes', () => {
    const block = renderStyleGuide(sanitizeStyleGuide({
      tense: 'past',
      voiceExemplars: [{ passage: 'The rain came sideways.', note: 'terse' }],
      voiceAntiExemplars: [{ passage: 'Verily the tempest did descend.', note: 'too ornate' }],
    }));
    expect(block).toContain('past tense');
    expect(block).toContain('MATCH this voice');
    expect(block).toContain('The rain came sideways.');
    expect(block).toContain('— terse');
    expect(block).toContain('NEVER drift toward this');
    expect(block).toContain('Verily the tempest did descend.');
    expect(block).toContain('— too ornate');
  });

  it('renders voice blocks even when no mechanical directives are set', () => {
    const block = renderStyleGuide(sanitizeStyleGuide({
      voiceExemplars: [{ passage: 'Clean, quiet sentences.' }],
    }));
    expect(block).not.toBeNull();
    expect(block).not.toContain('house style — follow exactly'); // no directive header
    expect(block).toContain('MATCH this voice');
    expect(block).toContain('Clean, quiet sentences.');
  });

  it('conditionally omits absent voice blocks (renders nothing)', () => {
    const block = renderStyleGuide(sanitizeStyleGuide({ tense: 'present' }));
    expect(block).toContain('present tense');
    expect(block).not.toContain('MATCH this voice');
    expect(block).not.toContain('NEVER drift toward this');
  });
});

describe('composeStyleNotes', () => {
  it('returns empty string when neither guide nor notes nor craft is present', () => {
    expect(composeStyleNotes(null)).toBe('');
    expect(composeStyleNotes({})).toBe('');
    expect(composeStyleNotes({ styleNotes: '   ' })).toBe('');
  });

  it('leads with the rendered guide, trails with free-text notes', () => {
    const out = composeStyleNotes({
      styleGuide: sanitizeStyleGuide({ tense: 'past' }),
      styleNotes: 'Noir and rain.',
    });
    expect(out).toContain('past tense');
    expect(out).toContain('Noir and rain.');
    expect(out.indexOf('past tense')).toBeLessThan(out.indexOf('Noir and rain.'));
  });

  it('does NOT append prose-craft doctrine by default (structural stages)', () => {
    const out = composeStyleNotes({ styleNotes: 'Noir.' });
    expect(out).toBe('Noir.');
    expect(out).not.toContain('Le Guin');
    expect(out).not.toContain('Prose craft');
  });

  it('appends the Le Guin prose-craft doctrine when proseCraft is set', () => {
    const out = composeStyleNotes({ styleNotes: 'Noir.' }, { proseCraft: true });
    expect(out).toContain('Noir.');
    expect(out).toContain(PROSE_CRAFT_DOCTRINE);
    expect(out).toContain('ancient wisdom'); // one of the banned clichés
    // Author notes lead; the baked doctrine trails.
    expect(out.indexOf('Noir.')).toBeLessThan(out.indexOf('Prose craft'));
  });

  it('appends craft even with an otherwise-empty series', () => {
    const out = composeStyleNotes(null, { proseCraft: true });
    expect(out).toBe(PROSE_CRAFT_DOCTRINE);
  });
});
