import { describe, it, expect } from 'vitest';
import { renderOrPrependSection } from './promptSectionRenderer.js';

describe('renderOrPrependSection', () => {
  it('replaces every occurrence of the token when present', () => {
    expect(renderOrPrependSection('A {tok} B {tok}', '{tok}', 'Heading', 'X')).toBe('A X B X');
  });

  it('prepends the block under a heading, or bare when heading is null, when the token is absent', () => {
    expect(renderOrPrependSection('Body', '{tok}', 'Heading', 'X')).toBe('## Heading\n\nX\n\n---\n\nBody');
    expect(renderOrPrependSection('Body', '{tok}', null, 'X')).toBe('X\n\n---\n\nBody');
  });

  it('inserts a block containing $& verbatim', () => {
    expect(renderOrPrependSection('A {tok} B', '{tok}', 'Heading', 'cost $& $1')).toBe('A cost $& $1 B');
  });
});
