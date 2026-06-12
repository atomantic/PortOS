import { describe, it, expect } from 'vitest';
import { diffLineBlocks, LINE_DIFF_CELL_CAP } from './diffLines.js';

// Reassemble each side from the block stream — the tiling invariant every
// renderer depends on.
const oldOf = (blocks) => blocks.flatMap((b) => (b.type === 'same' ? b.lines : b.oldLines)).join('\n');
const newOf = (blocks) => blocks.flatMap((b) => (b.type === 'same' ? b.lines : b.newLines)).join('\n');

describe('diffLineBlocks', () => {
  it('returns one same block for identical texts', () => {
    const text = 'one\ntwo\nthree';
    const { blocks } = diffLineBlocks(text, text);
    expect(blocks).toEqual([{ type: 'same', lines: ['one', 'two', 'three'] }]);
  });

  it('isolates a localized change between same blocks', () => {
    const oldText = 'a\nb\nc\nd\ne';
    const newText = 'a\nb\nC!\nd\ne';
    const { blocks } = diffLineBlocks(oldText, newText);
    expect(blocks.map((b) => b.type)).toEqual(['same', 'change', 'same']);
    expect(blocks[1].oldLines).toEqual(['c']);
    expect(blocks[1].newLines).toEqual(['C!']);
    expect(oldOf(blocks)).toBe(oldText);
    expect(newOf(blocks)).toBe(newText);
  });

  it('handles pure insertion (empty oldLines)', () => {
    const { blocks } = diffLineBlocks('a\nb', 'a\nx\ny\nb');
    const change = blocks.find((b) => b.type === 'change');
    expect(change.oldLines).toEqual([]);
    expect(change.newLines).toEqual(['x', 'y']);
  });

  it('handles pure deletion (empty newLines)', () => {
    const { blocks } = diffLineBlocks('a\nx\nb', 'a\nb');
    const change = blocks.find((b) => b.type === 'change');
    expect(change.oldLines).toEqual(['x']);
    expect(change.newLines).toEqual([]);
  });

  it('aligns duplicate blank lines by index, keeping separate edits separate', () => {
    const oldText = 'one\n\ntwo\n\nthree';
    const newText = 'ONE\n\ntwo\n\nTHREE';
    const { blocks } = diffLineBlocks(oldText, newText);
    const changes = blocks.filter((b) => b.type === 'change');
    expect(changes).toHaveLength(2);
    expect(changes[0].oldLines).toEqual(['one']);
    expect(changes[1].oldLines).toEqual(['three']);
    expect(oldOf(blocks)).toBe(oldText);
    expect(newOf(blocks)).toBe(newText);
  });

  it('tiles both sides verbatim across mixed edits', () => {
    const oldText = 'h1\np p p\np q p\n\ntail\nend';
    const newText = 'h1\nnew intro\np p p\np Q p\n\nend';
    const { blocks } = diffLineBlocks(oldText, newText);
    expect(oldOf(blocks)).toBe(oldText);
    expect(newOf(blocks)).toBe(newText);
  });

  it('treats null/undefined as empty', () => {
    const { blocks } = diffLineBlocks(null, undefined);
    expect(blocks).toEqual([{ type: 'same', lines: [''] }]);
  });

  it('keeps a localized edit cheap in a text far beyond the cap-sized line count', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const changed = lines.slice();
    changed[2500] = 'REPLACED';
    const { blocks } = diffLineBlocks(lines.join('\n'), changed.join('\n'));
    // Prefix/suffix trim leaves a one-line middle — no coarse fallback.
    expect(blocks.map((b) => b.type)).toEqual(['same', 'change', 'same']);
    expect(blocks[1].oldLines).toEqual(['line 2500']);
    expect(blocks[1].newLines).toEqual(['REPLACED']);
  });

  it('degrades to one coarse change block past the cell cap, preserving context', () => {
    // Every middle line differs and lines are unique, so no prefix/suffix trim
    // helps; 2500×2500 > 4M cells.
    const build = (p) => ['ctx-top', ...Array.from({ length: 2500 }, (_, i) => `${p}${i}`), 'ctx-bottom'];
    const a = build('a');
    const b = build('b');
    const { blocks } = diffLineBlocks(a.join('\n'), b.join('\n'));
    expect(blocks.map((x) => x.type)).toEqual(['same', 'change', 'same']);
    expect(blocks[0].lines).toEqual(['ctx-top']);
    expect(blocks[2].lines).toEqual(['ctx-bottom']);
    expect(blocks[1].oldLines).toHaveLength(2500);
  });

  it('exports the documented cap', () => {
    expect(LINE_DIFF_CELL_CAP).toBe(4_000_000);
  });
});
