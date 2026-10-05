import { describe, expect, it } from 'vitest';
import { FILM_STYLE_GRAMMARS, FILM_STYLE_PROMPT_MAX_CHARS, renderFilmStyleGrammarPrompt } from './filmStyleGrammars.js';
import { FILM_STYLE_PARTS, filmStyleGrammarSchema } from './filmStyleGrammarValidation.js';
import { PII_PATTERNS } from './piiRedactionPatterns.js';

const SECTION_HEADINGS = {
  essence: 'Essence:', rendering: 'Rendering:', colourLogic: 'Colour:', type: 'Type:', motion: 'Motion:',
  camera: 'Camera vocabulary:', sound: 'Sound:', nativeMoves: 'Native moves:', pitfalls: 'Pitfalls:',
};

describe('FILM_STYLE_GRAMMARS catalog', () => {
  it('ships eight schema-valid grammars with unique kebab-case ids', () => {
    expect(FILM_STYLE_GRAMMARS).toHaveLength(8);
    for (const grammar of FILM_STYLE_GRAMMARS) {
      const result = filmStyleGrammarSchema.safeParse(grammar);
      expect(result.success, `${grammar.id}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
    const ids = FILM_STYLE_GRAMMARS.map(g => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is deeply frozen so a caller cannot mutate the shared catalog', () => {
    expect(Object.isFrozen(FILM_STYLE_GRAMMARS)).toBe(true);
    expect(Object.isFrozen(FILM_STYLE_GRAMMARS[0].camera[0].canServe)).toBe(true);
  });

  it('contains no private-looking values', () => {
    const text = JSON.stringify(FILM_STYLE_GRAMMARS);
    for (const { code, pattern } of PII_PATTERNS) expect(pattern.test(text), code).toBe(false);
  });

  it('renders every grammar in full, without truncation, under the cap', () => {
    for (const grammar of FILM_STYLE_GRAMMARS) {
      const prompt = renderFilmStyleGrammarPrompt(grammar.id);
      expect(prompt.length, grammar.id).toBeLessThan(FILM_STYLE_PROMPT_MAX_CHARS);
      // The last section survives intact, so the cap never clipped authored text.
      expect(prompt.endsWith(`Pitfalls: ${grammar.pitfalls}`), grammar.id).toBe(true);
    }
  });
});

describe('renderFilmStyleGrammarPrompt', () => {
  const id = FILM_STYLE_GRAMMARS[0].id;

  it('renders exactly the selected parts, in catalog order', () => {
    const prompt = renderFilmStyleGrammarPrompt(id, { parts: ['sound', 'motion', 'camera', 'nativeMoves'] });
    const present = FILM_STYLE_PARTS.filter(part => prompt.includes(`\n${SECTION_HEADINGS[part]}`));
    expect(present).toEqual(['motion', 'camera', 'sound', 'nativeMoves']);
    expect(prompt.indexOf('Motion:')).toBeLessThan(prompt.indexOf('Sound:'));
    expect(renderFilmStyleGrammarPrompt(id, { parts: 'all' })).toBe(renderFilmStyleGrammarPrompt(id));
  });

  it('rejects an unknown id or invalid parts with a 400', () => {
    expect(() => renderFilmStyleGrammarPrompt('unknown')).toThrow(expect.objectContaining({ name: 'ServerError', status: 400 }));
    for (const parts of [[], ['palette'], ['motion', 'motion'], 'some']) {
      expect(() => renderFilmStyleGrammarPrompt(id, { parts })).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
});
