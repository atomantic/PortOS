/**
 * Pure record-transform tests for the mood board logic (issue #911). No I/O —
 * these lock the create/patch/item semantics the db store depends on, so the
 * two never drift without a live database.
 */

import { describe, it, expect } from 'vitest';
import {
  buildBoardRecord,
  applyBoardPatch,
  applyBoardRestore,
  addItem,
  updateItem,
  removeItem,
  sanitizeBoardForSync,
  mergeBoardRecord,
  imageUrlToAppAsset,
  MAX_ITEMS_PER_BOARD,
  applyPinterestLink,
  clearPinterestLinkRecord,
  appendPinterestPins,
} from './logic.js';

describe('buildBoardRecord', () => {
  it('builds a board with empty items, mirrored timestamps, and the soft-delete trio', () => {
    const board = buildBoardRecord({ name: 'Refs' }, { id: 'mb-1', now: 't0' });
    expect(board).toEqual({
      id: 'mb-1',
      name: 'Refs',
      description: '',
      items: [],
      createdAt: 't0',
      updatedAt: 't0',
      deleted: false,
      deletedAt: null,
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

describe('sanitizeBoardForSync', () => {
  it('drops a non-object or id-less record', () => {
    expect(sanitizeBoardForSync(null)).toBeNull();
    expect(sanitizeBoardForSync([])).toBeNull();
    expect(sanitizeBoardForSync({ name: 'no id' })).toBeNull();
  });
  it('normalizes the soft-delete trio and defaults updatedAt to createdAt', () => {
    const out = sanitizeBoardForSync({ id: 'mb-1', name: 'A', createdAt: 't0' });
    expect(out).toMatchObject({ id: 'mb-1', createdAt: 't0', updatedAt: 't0', deleted: false, deletedAt: null });
  });
  it('preserves a tombstone', () => {
    const out = sanitizeBoardForSync({ id: 'mb-1', name: 'A', createdAt: 't0', updatedAt: 't1', deleted: true, deletedAt: 't1' });
    expect(out).toMatchObject({ deleted: true, deletedAt: 't1' });
  });
});

describe('mergeBoardRecord (LWW)', () => {
  const board = (over = {}) => ({ id: 'mb-1', name: 'A', description: '', items: [], createdAt: 't0', updatedAt: '2026-06-23T00:00:00.000Z', deleted: false, deletedAt: null, ...over });

  it('inserts when there is no local copy', () => {
    const { next, inserted, remoteWins } = mergeBoardRecord(null, board());
    expect(inserted).toBe(true);
    expect(remoteWins).toBe(true);
    expect(next.id).toBe('mb-1');
  });
  it('drops a malformed remote', () => {
    expect(mergeBoardRecord(board(), { name: 'no id' }).next).toBeNull();
  });
  it('newer remote updatedAt wins', () => {
    const local = board({ updatedAt: '2026-06-23T00:00:00.000Z' });
    const remote = board({ name: 'B', updatedAt: '2026-06-24T00:00:00.000Z' });
    const { remoteWins, changed, next } = mergeBoardRecord(local, remote);
    expect(remoteWins).toBe(true);
    expect(changed).toBe(true);
    expect(next.name).toBe('B');
  });
  it('older remote loses (local kept)', () => {
    const local = board({ name: 'local', updatedAt: '2026-06-24T00:00:00.000Z' });
    const remote = board({ name: 'remote', updatedAt: '2026-06-23T00:00:00.000Z' });
    const { remoteWins, next } = mergeBoardRecord(local, remote);
    expect(remoteWins).toBe(false);
    expect(next.name).toBe('local');
  });
  it('a tombstone with a newer updatedAt wins over a live local', () => {
    const local = board({ updatedAt: '2026-06-23T00:00:00.000Z' });
    const remote = board({ updatedAt: '2026-06-24T00:00:00.000Z', deleted: true, deletedAt: '2026-06-24T00:00:00.000Z' });
    const { remoteWins, next } = mergeBoardRecord(local, remote);
    expect(remoteWins).toBe(true);
    expect(next.deleted).toBe(true);
  });
  it('reports changed:false when the winner is byte-identical to local', () => {
    const local = board();
    const { changed } = mergeBoardRecord(local, board());
    expect(changed).toBe(false);
  });
});

describe('imageUrlToAppAsset', () => {
  it('resolves a gallery image path to { kind: image, filename }', () => {
    expect(imageUrlToAppAsset('/data/images/foo.png')).toEqual({ kind: 'image', filename: 'foo.png' });
    expect(imageUrlToAppAsset('/data/images/sub/foo.png?v=2')).toEqual({ kind: 'image', filename: 'foo.png' });
  });
  it('resolves an image-ref path (canon-sheet / noun pins) to { kind: image-ref, filename }', () => {
    expect(imageUrlToAppAsset('/data/image-refs/canon-abc.png')).toEqual({ kind: 'image-ref', filename: 'canon-abc.png' });
  });
  it('treats a bare/relative ref as a gallery image (legacy shape)', () => {
    expect(imageUrlToAppAsset('foo.png')).toEqual({ kind: 'image', filename: 'foo.png' });
  });
  it('returns null for external / other-absolute / empty values', () => {
    expect(imageUrlToAppAsset('https://x/y.png')).toBeNull();
    expect(imageUrlToAppAsset('data:image/png;base64,AAA')).toBeNull();
    expect(imageUrlToAppAsset('/data/videos/clip.mp4')).toBeNull(); // video bytes ride a media-key, not an imageUrl
    expect(imageUrlToAppAsset('/etc/passwd')).toBeNull();
    expect(imageUrlToAppAsset('')).toBeNull();
    expect(imageUrlToAppAsset(null)).toBeNull();
  });
});

describe('applyBoardRestore', () => {
  it('wholesale-restores name/description/items (unlike applyBoardPatch) and bumps updatedAt', () => {
    const base = buildBoardRecord({ name: 'A' }, { id: 'mb-1', now: 't0' });
    const items = [{ id: 'mbi-1', type: 'text', text: 'restored', mediaKey: null, imageUrl: null, caption: null, source: null, createdAt: 't0' }];
    const next = applyBoardRestore(base, { name: 'B', description: 'd', items });
    expect(next.name).toBe('B');
    expect(next.description).toBe('d');
    expect(next.items).toEqual(items);
    expect(next.updatedAt).not.toBe('t0');
  });
  it('ignores a non-array items field', () => {
    const base = { ...buildBoardRecord({ name: 'A' }, { id: 'mb-1', now: 't0' }), items: [{ id: 'x' }] };
    expect(applyBoardRestore(base, { items: 'nope' }).items).toEqual([{ id: 'x' }]);
  });
});

describe('applyPinterestLink', () => {
  const base = () => buildBoardRecord({ name: 'A' }, { id: 'mb-1', now: 't0' });

  it('stores the feed + board URLs and seeds sync state', () => {
    const next = applyPinterestLink(base(), { feedUrl: 'https://www.pinterest.com/j/b.rss', boardUrl: 'https://www.pinterest.com/j/b/' });
    expect(next.pinterest).toEqual({
      feedUrl: 'https://www.pinterest.com/j/b.rss',
      boardUrl: 'https://www.pinterest.com/j/b/',
      lastSyncedAt: null,
    });
    expect(next.updatedAt).not.toBe('t0');
  });

  it('preserves the prior sync timestamp when re-linking', () => {
    const linked = { ...base(), pinterest: { feedUrl: 'old', boardUrl: 'oldb', lastSyncedAt: 's1' } };
    const next = applyPinterestLink(linked, { feedUrl: 'new', boardUrl: 'newb' });
    expect(next.pinterest).toMatchObject({ feedUrl: 'new', lastSyncedAt: 's1' });
  });
});

describe('clearPinterestLinkRecord', () => {
  it('removes the pinterest field and bumps updatedAt', () => {
    const linked = { ...buildBoardRecord({ name: 'A' }, { id: 'mb-1', now: 't0' }), pinterest: { feedUrl: 'f' } };
    const { board, changed } = clearPinterestLinkRecord(linked);
    expect(changed).toBe(true);
    expect(board.pinterest).toBeUndefined();
    expect(board.updatedAt).not.toBe('t0');
  });

  it('is a no-op when not linked', () => {
    const board = buildBoardRecord({ name: 'A' }, { id: 'mb-1', now: 't0' });
    const out = clearPinterestLinkRecord(board);
    expect(out.changed).toBe(false);
    expect(out.board).toBe(board);
  });
});

describe('appendPinterestPins', () => {
  const linked = () => ({
    ...buildBoardRecord({ name: 'A' }, { id: 'mb-1', now: 't0' }),
    pinterest: { feedUrl: 'f', boardUrl: 'b', lastSyncedAt: null },
  });
  const imp = (n) => ({ imageUrl: `/data/images/p${n}.jpg`, caption: `c${n}`, source: `https://www.pinterest.com/pin/${n}/` });

  it('appends image items and stamps sync state', () => {
    const { board, added } = appendPinterestPins(linked(), [imp(1), imp(2)], { syncedAt: 's1' });
    expect(added).toBe(2);
    expect(board.items.map((it) => it.source)).toEqual(['https://www.pinterest.com/pin/1/', 'https://www.pinterest.com/pin/2/']);
    expect(board.items[0]).toMatchObject({ type: 'image', imageUrl: '/data/images/p1.jpg', caption: 'c1' });
    expect(board.pinterest).toMatchObject({ lastSyncedAt: 's1' });
  });

  it('dedupes against existing item sources', () => {
    const existing = { ...linked(), items: [{ id: 'mbi-x', type: 'image', source: 'https://www.pinterest.com/pin/1/' }] };
    const { added, board } = appendPinterestPins(existing, [imp(1), imp(2)], { syncedAt: 's1' });
    expect(added).toBe(1);
    expect(board.items).toHaveLength(2);
  });

  it('stamps lastSyncedAt even when nothing new was added', () => {
    const { board, added } = appendPinterestPins(linked(), [], { syncedAt: 's2' });
    expect(added).toBe(0);
    expect(board.pinterest).toMatchObject({ lastSyncedAt: 's2' });
  });

  it('truncates to MAX_ITEMS_PER_BOARD capacity', () => {
    const full = { ...linked(), items: Array.from({ length: MAX_ITEMS_PER_BOARD - 1 }, (_, i) => ({ id: `e${i}`, type: 'image', source: `e${i}` })) };
    const { added } = appendPinterestPins(full, [imp(1), imp(2), imp(3)], { syncedAt: 's1' });
    expect(added).toBe(1);
  });
});
