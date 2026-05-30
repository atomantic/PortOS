import { describe, it, expect } from 'vitest';
import { chunkRawText, CATALOG_CHUNK_MAX_CHARS } from './catalogChunking.js';

describe('catalogChunking.chunkRawText', () => {
  it('returns a single chunk for short input (≤ maxChars)', () => {
    const text = 'a short paste';
    expect(chunkRawText(text)).toEqual([text]);
  });

  it('returns a single chunk exactly at the cap', () => {
    const text = 'x'.repeat(CATALOG_CHUNK_MAX_CHARS);
    const chunks = chunkRawText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('splits input larger than maxChars into N chunks each ≤ cap', () => {
    const maxChars = 100;
    // 5 paragraphs of ~80 chars each, separated by blank lines.
    const para = 'word '.repeat(15).trim(); // ~74 chars
    const text = Array.from({ length: 8 }, () => para).join('\n\n');
    expect(text.length).toBeGreaterThan(maxChars);
    const chunks = chunkRawText(text, { maxChars });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(maxChars);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('prefers paragraph boundaries when splitting', () => {
    const maxChars = 60;
    const a = 'A'.repeat(40);
    const b = 'B'.repeat(40);
    const text = `${a}\n\n${b}`;
    const chunks = chunkRawText(text, { maxChars });
    expect(chunks).toHaveLength(2);
    // First chunk ends with the paragraph separator, second starts clean.
    expect(chunks[0]).toBe(`${a}\n\n`);
    expect(chunks[1]).toBe(b);
    expect(chunks.join('')).toBe(text);
  });

  it('falls back to newline, then sentence boundary', () => {
    const maxChars = 50;
    const text = `${'a'.repeat(30)}\n${'b'.repeat(15)}. ${'c'.repeat(15)}`;
    const chunks = chunkRawText(text, { maxChars });
    expect(chunks.length).toBeGreaterThan(1);
    // First split should land on the newline.
    expect(chunks[0]).toBe(`${'a'.repeat(30)}\n`);
    expect(chunks.join('')).toBe(text);
  });

  it('splits on sentence boundary when no paragraph/newline break exists', () => {
    const maxChars = 40;
    const text = `${'one '.repeat(8).trim()}. ${'two '.repeat(8).trim()}.`;
    const chunks = chunkRawText(text, { maxChars });
    expect(chunks.length).toBeGreaterThan(1);
    // The boundary after ". " keeps the period+space with the first chunk.
    expect(chunks[0].endsWith('. ')).toBe(true);
    expect(chunks.join('')).toBe(text);
  });

  it('avoids splitting mid-word when only whitespace is available', () => {
    const maxChars = 20;
    const text = 'alpha bravo charlie delta echo foxtrot golf';
    const chunks = chunkRawText(text, { maxChars });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks.slice(0, -1)) {
      // Each non-final chunk ends on a whitespace boundary (no truncated word
      // at the seam): the char after the chunk is non-space, the chunk's last
      // char is a space.
      expect(c.endsWith(' ')).toBe(true);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('hard-cuts pathological no-whitespace input at the cap', () => {
    const maxChars = 50;
    const text = 'x'.repeat(230); // single run, no break opportunities
    const chunks = chunkRawText(text, { maxChars });
    expect(chunks.length).toBe(Math.ceil(230 / 50));
    for (const c of chunks.slice(0, -1)) {
      expect(c.length).toBe(maxChars);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('respects the maxChunks ceiling, last chunk holds the remainder', () => {
    const maxChars = 10;
    const maxChunks = 3;
    const text = 'y'.repeat(100); // would be 10 chunks unbounded
    const chunks = chunkRawText(text, { maxChars, maxChunks });
    expect(chunks).toHaveLength(maxChunks);
    // First two chunks at cap, last chunk holds everything else.
    expect(chunks[0].length).toBe(maxChars);
    expect(chunks[1].length).toBe(maxChars);
    expect(chunks[2].length).toBe(100 - 2 * maxChars);
    expect(chunks.join('')).toBe(text);
  });

  it('reassembles losslessly for mixed content', () => {
    const maxChars = 64;
    const text = [
      'Title line here.',
      '',
      'A paragraph with several sentences. It keeps going. And going more.',
      '',
      'Anotherlongunbrokenword'.repeat(8),
      '',
      'Final  paragraph\twith\tmixed   whitespace.',
    ].join('\n');
    const chunks = chunkRawText(text, { maxChars });
    expect(chunks.join('')).toBe(text);
    // Every non-final chunk respects the cap (final may exceed only via the
    // remainder path, which doesn't apply here since maxChunks default is high).
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(maxChars);
    }
  });

  it('returns [] for non-string input', () => {
    expect(chunkRawText(null)).toEqual([]);
    expect(chunkRawText(undefined)).toEqual([]);
    expect(chunkRawText(42)).toEqual([]);
  });
});
