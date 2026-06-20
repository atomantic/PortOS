/**
 * Pure record-transform tests for the mood board logic (issue #911). No I/O —
 * these lock the create/patch/item semantics the db store depends on, so the
 * two never drift without a live database.
 */

import { describe, it, expect } from 'vitest';
import {
  buildBoardRecord,
  applyBoardPatch,
  addItem,
  updateItem,
  removeItem,
  MAX_ITEMS_PER_BOARD,
} from './logic.js';

describe('buildBoardRecord', () => {
  it('builds a board with empty items and mirrored timestamps', () => {
    const board = buildBoardRecord({ name: 'Refs' }, { id: 'mb-1', now: 't0' });
    expect(board).toEqual({
      id: 'mb-1',
      name: 'Refs',
      description: '',
      items: [],
      createdAt: 't0',
      updatedAt: 't0',
    });
  });
  it('keeps a provided description', () => {
    expect(buildBoardRecord({ name: 'Refs', description: 'd' }, { id: 'mb-1', now: 't0' }).description).toBe('d');
  });
});

describe('applyBoardPatch', () => {
  const base = buildBoardRecord({ name: 'A', description: 'old' }, { id: 'mb-1', now: 't0' });
  it('updates only present fields and bumps updatedAt', () => {
    const next = applyBoardPatch(base, { name: 'B' });
    expect(next.name).toBe('B');
    expect(next.description).toBe('old');
    expect(next.updatedAt).not.toBe('t0');
  });
  it('treats an empty-string description as a clear', () => {
    expect(applyBoardPatch(base, { description: '' }).description).toBe('');
  });
  it('preserves description when the key is absent', () => {
    expect(applyBoardPatch(base, { name: 'B' }).description).toBe('old');
  });
});

describe('addItem', () => {
  const base = buildBoardRecord({ name: 'A' }, { id: 'mb-1', now: 't0' });
  it('normalizes an image item with imageUrl', () => {
    const { board, item } = addItem(base, { type: 'image', imageUrl: 'https://x/y.png', caption: 'c' });
    expect(item.type).toBe('image');
    expect(item.imageUrl).toBe('https://x/y.png');
    expect(item.text).toBeNull();
    expect(item.caption).toBe('c');
    expect(item.id).toMatch(/^mbi-/);
    expect(board.items).toHaveLength(1);
  });
  it('normalizes an image item with mediaKey', () => {
    const { item } = addItem(base, { type: 'image', mediaKey: 'image:a.png' });
    expect(item.mediaKey).toBe('image:a.png');
    expect(item.imageUrl).toBeNull();
  });
  it('normalizes a text item and nulls image fields', () => {
    const { item } = addItem(base, { type: 'text', text: 'note' });
    expect(item.text).toBe('note');
    expect(item.mediaKey).toBeNull();
    expect(item.imageUrl).toBeNull();
  });
  it('throws BOARD_FULL at the item cap', () => {
    const full = { ...base, items: Array.from({ length: MAX_ITEMS_PER_BOARD }, (_, i) => ({ id: `i${i}` })) };
    expect(() => addItem(full, { type: 'text', text: 'x' })).toThrow(/full/i);
  });
});

describe('updateItem', () => {
  const withItem = (() => {
    const { board } = addItem(buildBoardRecord({ name: 'A' }, { id: 'mb-1', now: 't0' }), { type: 'text', text: 'orig' });
    return board;
  })();
  const itemId = withItem.items[0].id;

  it('patches present fields only', () => {
    const { item } = updateItem(withItem, itemId, { caption: 'new' });
    expect(item.caption).toBe('new');
    expect(item.text).toBe('orig');
  });
  it('throws NOT_FOUND for an unknown item id', () => {
    expect(() => updateItem(withItem, 'nope', { caption: 'x' })).toThrow(/not found/i);
  });
  it('ignores type-inappropriate body fields (text item cannot gain an imageUrl)', () => {
    const { item } = updateItem(withItem, itemId, { imageUrl: 'https://x/y.png', mediaKey: 'image:a.png', text: 'changed' });
    expect(item.imageUrl).toBeNull();
    expect(item.mediaKey).toBeNull();
    expect(item.text).toBe('changed');
  });
  it('ignores text on an image item', () => {
    const { board } = addItem(buildBoardRecord({ name: 'A' }, { id: 'mb-2', now: 't0' }), { type: 'image', imageUrl: 'https://x/y.png' });
    const imgId = board.items[0].id;
    const { item } = updateItem(board, imgId, { text: 'nope', caption: 'ok' });
    expect(item.text).toBeNull();
    expect(item.caption).toBe('ok');
  });
  it('rejects clearing an image item’s only source', () => {
    const { board } = addItem(buildBoardRecord({ name: 'A' }, { id: 'mb-3', now: 't0' }), { type: 'image', imageUrl: 'https://x/y.png' });
    const imgId = board.items[0].id;
    expect(() => updateItem(board, imgId, { imageUrl: null })).toThrow(/mediaKey or imageUrl/i);
  });
  it('rejects blanking a text item', () => {
    expect(() => updateItem(withItem, itemId, { text: '   ' })).toThrow(/non-empty text/i);
  });
});

describe('removeItem', () => {
  const withItem = (() => {
    const { board } = addItem(buildBoardRecord({ name: 'A' }, { id: 'mb-1', now: 't0' }), { type: 'text', text: 'orig' });
    return board;
  })();
  const itemId = withItem.items[0].id;

  it('removes a present item', () => {
    const { board, removed } = removeItem(withItem, itemId);
    expect(removed).toBe(true);
    expect(board.items).toHaveLength(0);
  });
  it('returns removed:false (no write) for an absent id', () => {
    const { board, removed } = removeItem(withItem, 'nope');
    expect(removed).toBe(false);
    expect(board).toBe(withItem);
  });
});
