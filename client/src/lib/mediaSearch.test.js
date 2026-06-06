import { describe, it, expect } from 'vitest';
import { buildMediaHaystack, tokenizeQuery, matchHaystack, filterByQuery } from './mediaSearch';

const img = (over = {}) => ({
  kind: 'image',
  prompt: 'a neon sunset over the bay',
  negativePrompt: 'blurry',
  modelId: 'flux2',
  filename: 'abc123.png',
  seed: 42,
  width: 1024,
  height: 768,
  loraNames: ['lora-realstagram-v7.safetensors'],
  universeName: 'Ashworld',
  entryName: 'Ash',
  ...over,
});

describe('buildMediaHaystack', () => {
  it('includes prompt, model, seed, resolution, LoRA, and universe tags (lowercased)', () => {
    const h = buildMediaHaystack(img());
    expect(h).toContain('neon sunset');
    expect(h).toContain('flux2');
    expect(h).toContain('seed 42');
    expect(h).toContain('1024x768');
    expect(h).toContain('lora-realstagram-v7.safetensors');
    expect(h).toContain('ashworld');
    expect(h).toContain('ash');
    expect(h).toBe(h.toLowerCase());
  });

  it('returns an empty string for nullish input', () => {
    expect(buildMediaHaystack(null)).toBe('');
  });

  it('omits seed/resolution fragments when absent', () => {
    const h = buildMediaHaystack(img({ seed: null, width: 0, height: 0 }));
    expect(h).not.toContain('seed');
    expect(h).not.toContain('x768');
  });
});

describe('tokenizeQuery', () => {
  it('lowercases and splits on whitespace, dropping empties', () => {
    expect(tokenizeQuery('  Neon   Sunset ')).toEqual(['neon', 'sunset']);
    expect(tokenizeQuery('')).toEqual([]);
    expect(tokenizeQuery(null)).toEqual([]);
  });
});

describe('matchHaystack', () => {
  it('requires every token (AND semantics)', () => {
    const h = buildMediaHaystack(img());
    expect(matchHaystack(h, ['neon', 'flux2'])).toBe(true);
    expect(matchHaystack(h, ['neon', 'missing'])).toBe(false);
    expect(matchHaystack(h, [])).toBe(true);
  });
});

describe('filterByQuery', () => {
  const items = [
    img({ filename: 'a.png', prompt: 'neon sunset', modelId: 'flux2' }),
    img({ filename: 'b.png', prompt: 'forest morning', modelId: 'sdxl', universeName: null, entryName: null, loraNames: [] }),
  ];

  it('returns all items for an empty query', () => {
    expect(filterByQuery(items, '')).toHaveLength(2);
  });

  it('AND-matches across tokens in any order', () => {
    const res = filterByQuery(items, 'flux2 neon');
    expect(res).toHaveLength(1);
    expect(res[0].filename).toBe('a.png');
  });

  it('returns empty when no item matches all tokens', () => {
    expect(filterByQuery(items, 'neon sdxl')).toHaveLength(0);
  });
});
