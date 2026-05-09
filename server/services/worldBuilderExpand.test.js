import { describe, it, expect } from 'vitest';
import { __testing } from './worldBuilderExpand.js';
import { WORLD_CATEGORIES } from './worldBuilder.js';

const { extractJson, normalizeCategories } = __testing;

describe('worldBuilderExpand.extractJson', () => {
  it('parses a raw JSON object', () => {
    const obj = { stylePrompt: 'a, b, c', negativePrompt: 'blur', categories: {} };
    expect(extractJson(JSON.stringify(obj))).toEqual(obj);
  });

  it('strips ```json fences', () => {
    const fenced = '```json\n{"stylePrompt":"x","categories":{}}\n```';
    expect(extractJson(fenced)).toEqual({ stylePrompt: 'x', categories: {} });
  });

  it('strips bare ``` fences', () => {
    const fenced = '```\n{"stylePrompt":"x"}\n```';
    expect(extractJson(fenced)).toEqual({ stylePrompt: 'x' });
  });

  it('skips a preamble before the first { … } block', () => {
    const raw = 'Here is the JSON you asked for:\n{"stylePrompt":"x","negativePrompt":"y"}\nHope this helps!';
    expect(extractJson(raw)).toEqual({ stylePrompt: 'x', negativePrompt: 'y' });
  });

  it('rejects empty / non-string input', () => {
    expect(() => extractJson('')).toThrow(/Empty LLM response/);
    expect(() => extractJson(null)).toThrow(/Empty LLM response/);
    expect(() => extractJson(undefined)).toThrow(/Empty LLM response/);
  });

  it('throws when no JSON object can be parsed', () => {
    expect(() => extractJson('totally bogus output, no braces')).toThrow();
    expect(() => extractJson('{ this is not valid json')).toThrow();
  });
});

describe('worldBuilderExpand.normalizeCategories', () => {
  it('returns all canonical categories with empty variations on empty input', () => {
    const out = normalizeCategories({});
    for (const key of WORLD_CATEGORIES) {
      expect(out[key]).toEqual({ variations: [] });
    }
  });

  it('coerces a flat array of strings into label/prompt pairs', () => {
    const out = normalizeCategories({
      landscapes: ['Crystalline canyon basin', 'Salt flat ruins'],
    });
    expect(out.landscapes.variations).toEqual([
      { label: 'Crystalline canyon basin', prompt: 'Crystalline canyon basin' },
      { label: 'Salt flat ruins', prompt: 'Salt flat ruins' },
    ]);
  });

  it('truncates long string-shape labels at 80 chars', () => {
    const longText = 'x'.repeat(200);
    const out = normalizeCategories({ characters: [longText] });
    expect(out.characters.variations[0].label).toHaveLength(80);
    expect(out.characters.variations[0].prompt).toBe(longText);
  });

  it('accepts the canonical { variations: [{label,prompt}] } shape', () => {
    const out = normalizeCategories({
      vehicles: { variations: [{ label: 'Walker mech', prompt: 'rusted six-leg walker mech' }] },
    });
    expect(out.vehicles.variations).toEqual([
      { label: 'Walker mech', prompt: 'rusted six-leg walker mech' },
    ]);
  });

  it('drops malformed variations with missing label or prompt', () => {
    const out = normalizeCategories({
      structures: {
        variations: [
          { label: 'Tower', prompt: 'spire of obsidian' },   // keep
          { label: '', prompt: 'no label' },                 // drop
          { label: 'No prompt', prompt: '' },                // drop
          { label: 42, prompt: 'numeric label' },            // drop (label not string)
          null,                                              // drop
        ],
      },
    });
    expect(out.structures.variations).toEqual([
      { label: 'Tower', prompt: 'spire of obsidian' },
    ]);
  });

  it('ignores unknown categories not in WORLD_CATEGORIES', () => {
    const out = normalizeCategories({
      landscapes: { variations: [{ label: 'A', prompt: 'a' }] },
      bogus: { variations: [{ label: 'X', prompt: 'x' }] },
    });
    expect(out.landscapes.variations).toHaveLength(1);
    expect(out.bogus).toBeUndefined();
  });

  it('treats a non-object category as empty variations (not a crash)', () => {
    const out = normalizeCategories({ characters: 'not an object' });
    expect(out.characters).toEqual({ variations: [] });
  });
});
